/**
 * Compaction strategies — reduce context size by masking tool results,
 * pruning old messages, or summarizing via LLM.
 *
 * Strategies are applied in order of aggressiveness based on context level.
 * All strategies mutate the messages array in-place to avoid copies.
 */

import type { ContextLevel, CompactionResult } from "./types.js";
import { estimateMessageTokens } from "./context-tracker.js";
import { debugLog, isDebugEnabled } from "../debug/logger.js";

/** Message shape compatible with both engine/llm.ts Message and SessionMessage. */
export interface CompactableMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

/** Options for compaction. LLM summarization requires a callLLM function. */
export interface CompactionOptions {
  /** Call the LLM to generate a summary. Required for emergency level. */
  callLLM?: (prompt: string) => Promise<string>;
  /** Number of recent exchanges to keep untouched. Default: 10. */
  keepLastExchanges?: number;
  /** Number of verbatim exchanges to keep for emergency. Default: 5. */
  emergencyKeepLast?: number;
  /** Force compaction even when context is low or few messages exist. */
  force?: boolean;
}

const SUMMARIZATION_PROMPT = `Summarize this conversation history into a concise context document.
Preserve: current goal, key decisions made, files modified, errors encountered, next steps.
Keep under 2000 tokens.

Conversation:
`;

/**
 * Run the appropriate compaction strategy for the given context level.
 * Mutates the messages array in-place.
 *
 * When `force` is set, compaction runs regardless of message count —
 * keepLast is reduced to fit the actual conversation size.
 *
 * Returns null if no compaction was applied (normal/warning levels).
 */
export async function compact(
  messages: CompactableMessage[],
  level: ContextLevel,
  options?: CompactionOptions,
): Promise<CompactionResult | null> {
  if (!options?.force && (level === "normal" || level === "warning")) return null;

  const beforeTokens = estimateMessageTokens(messages);

  let result: CompactionResult;

  const force = options?.force;

  switch (level) {
    case "high":
      result = maskToolResults(messages, options?.keepLastExchanges ?? 10, force);
      break;
    case "critical":
      result = pruneMessages(messages, options?.keepLastExchanges ?? 10, force);
      break;
    case "emergency":
      result = await llmSummarize(messages, options);
      break;
    default:
      return null;
  }

  result.beforeTokens = beforeTokens;
  result.afterTokens = estimateMessageTokens(messages);

  if (isDebugEnabled()) {
    debugLog("info", "llm", "context:compaction", {
      data: {
        level,
        strategy: result.strategy,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        messagesAffected: result.messagesAffected,
        reduction: result.beforeTokens - result.afterTokens,
      },
    });
  }

  return result;
}

// ── Strategy 1: Tool Result Masking (high) ───────────────────────────────────

/**
 * Replace content of tool result messages older than the last N exchanges
 * with a short placeholder. Preserves toolCallId so the LLM knows a
 * tool WAS called.
 */
function maskToolResults(
  messages: CompactableMessage[],
  keepLast: number,
  force?: boolean,
): CompactionResult {
  const cutoff = findExchangeCutoff(messages, keepLast, force);
  let affected = 0;

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]!;
    if (msg.role === "tool" && msg.content.length > 100) {
      const toolName = msg.metadata?.toolName ?? "unknown";
      msg.content = `[Tool: ${toolName} — result truncated. Re-run tool if needed.]`;
      affected++;
    }
  }

  return { strategy: "tool_mask", beforeTokens: 0, afterTokens: 0, messagesAffected: affected };
}

// ── Strategy 2: Pruning (critical) ──────────────────────────────────────────

/**
 * Remove tool messages and truncate user/assistant messages outside
 * the last N exchanges. Keeps the system prompt at index 0.
 */
function pruneMessages(
  messages: CompactableMessage[],
  keepLast: number,
  force?: boolean,
): CompactionResult {
  const cutoff = findExchangeCutoff(messages, keepLast, force);
  let affected = 0;

  // Work backwards to avoid index shifting
  for (let i = cutoff - 1; i >= 0; i--) {
    const msg = messages[i]!;

    if (msg.role === "system" && i === 0) {
      // Keep original system prompt
      continue;
    }

    if (msg.role === "system" || msg.role === "tool") {
      // Remove entirely
      messages.splice(i, 1);
      affected++;
      continue;
    }

    if (msg.role === "user" && msg.content.length > 500) {
      msg.content = msg.content.slice(0, 200) + "\n[...truncated]";
      affected++;
    } else if (msg.role === "assistant" && msg.content.length > 1000) {
      msg.content = msg.content.slice(0, 500) + "\n[...truncated]";
      affected++;
    }
  }

  return { strategy: "prune", beforeTokens: 0, afterTokens: 0, messagesAffected: affected };
}

// ── Strategy 3: LLM Summarization (emergency) ──────────────────────────────

/**
 * Summarize the entire conversation into a ~2000 token summary.
 * Replace history with [summary as system msg] + last N exchanges.
 */
async function llmSummarize(
  messages: CompactableMessage[],
  options?: CompactionOptions,
): Promise<CompactionResult> {
  const keepLast = options?.emergencyKeepLast ?? 5;

  if (!options?.callLLM) {
    // Fallback to pruning if no LLM available
    return pruneMessages(messages, keepLast, options?.force);
  }

  const cutoff = findExchangeCutoff(messages, keepLast, options?.force);
  const toSummarize = messages.slice(0, cutoff);

  // Build a compact representation for summarization
  const historyText = toSummarize
    .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
    .join("\n");

  const summary = await options.callLLM(SUMMARIZATION_PROMPT + historyText);

  // Keep the tail verbatim
  const tail = messages.slice(cutoff);

  // Replace entire array contents
  messages.length = 0;
  messages.push(
    { role: "system", content: `[Conversation Summary]\n${summary}` },
    ...tail,
  );

  return {
    strategy: "llm_summarize",
    beforeTokens: 0,
    afterTokens: 0,
    messagesAffected: toSummarize.length,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the message index that marks the start of the last N user/assistant exchanges.
 * An "exchange" is a user message followed by an assistant response.
 *
 * When `force` is true and fewer than `keepLast` exchanges exist,
 * keeps the minimum of available exchanges minus 1 (at least 1 exchange
 * must exist to compact anything before it).
 */
function findExchangeCutoff(
  messages: CompactableMessage[],
  keepLast: number,
  force?: boolean,
): number {
  let exchanges = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      exchanges++;
      if (exchanges >= keepLast) return i;
    }
  }

  // Fewer than keepLast exchanges — if forced, keep all but the oldest exchange
  if (force && exchanges > 1) {
    // Find the second user message from the end — keep from there onward
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        count++;
        if (count >= exchanges - 1) return i;
      }
    }
  }

  return 0;
}
