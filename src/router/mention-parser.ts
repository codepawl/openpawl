/**
 * Parse @agent mentions from user prompts.
 * Pure string parsing — no LLM, no heavy regex engine. Must be < 1ms.
 */

import type { AgentMention, MentionParseResult } from "./router-types.js";

const DEFAULT_ALIASES: Record<string, string> = {
  code: "coder",
  review: "reviewer",
  test: "tester",
  debug: "debugger",
  plan: "planner",
  research: "researcher",
  ask: "assistant",
  help: "assistant",
};

/**
 * Parse @agent mentions from a prompt string.
 *
 * Rules:
 * - @agentId at word boundary (case-insensitive)
 * - Aliases resolved (e.g. @code → coder)
 * - Ignores @mentions inside backtick code blocks
 * - Ignores email-like patterns (word@agent)
 * - Deduplicates same-agent mentions (merges tasks)
 * - Task = text after @mention until next @mention or end
 */
export function parseMentions(
  prompt: string,
  knownAgentIds: string[],
  aliases?: Record<string, string>,
): MentionParseResult {
  const aliasMap = aliases ?? DEFAULT_ALIASES;
  const knownSet = new Set(knownAgentIds.map((id) => id.toLowerCase()));

  // Also include alias keys as "known" for matching
  for (const alias of Object.keys(aliasMap)) {
    const target = aliasMap[alias]!;
    if (knownSet.has(target.toLowerCase())) {
      knownSet.add(alias.toLowerCase());
    }
  }

  const processedPrompt = prompt;

  // Find code block ranges to exclude
  const codeRanges = findCodeBlockRanges(processedPrompt);

  const mentions: AgentMention[] = [];
  const mentionPositions: Array<{ start: number; end: number; agentId: string; raw: string }> = [];

  // Scan for @mentions
  for (let i = 0; i < processedPrompt.length; i++) {
    if (processedPrompt[i] !== "@") continue;

    // Skip if inside a code block
    if (isInCodeBlock(i, codeRanges)) continue;

    // Skip email-like: character before @ is a word char (not whitespace/start)
    if (i > 0 && /\w/.test(processedPrompt[i - 1]!)) continue;

    // Extract the identifier after @
    const afterAt = processedPrompt.slice(i + 1);
    const match = afterAt.match(/^([a-zA-Z][a-zA-Z0-9_-]*)/);
    if (!match) continue;

    const raw = match[1]!;
    const rawLower = raw.toLowerCase();

    // Check if it's a known agent or alias
    if (!knownSet.has(rawLower)) continue;

    // Resolve alias
    const agentId = aliasMap[rawLower]
      ? aliasMap[rawLower]!
      : rawLower;

    // Only add if the resolved agent is actually known
    if (!knownAgentIds.some((id) => id.toLowerCase() === agentId.toLowerCase())) continue;

    mentionPositions.push({
      start: i,
      end: i + 1 + raw.length,
      agentId,
      raw: `@${raw}`,
    });
  }

  if (mentionPositions.length === 0) {
    return {
      mentions: [],
      cleanedPrompt: processedPrompt.trim(),
      hasExplicitRouting: false,
    };
  }

  // Extract tasks: text between mentions
  for (let i = 0; i < mentionPositions.length; i++) {
    const current = mentionPositions[i]!;
    const nextStart = mentionPositions[i + 1]?.start ?? processedPrompt.length;
    const taskText = processedPrompt.slice(current.end, nextStart).trim();

    mentions.push({
      agentId: current.agentId,
      raw: current.raw,
      position: current.start,
      task: taskText || undefined,
    });
  }

  // Deduplicate: merge tasks for same agent
  const deduped = deduplicateMentions(mentions);

  // Build cleaned prompt: remove @mention tokens
  const cleanedPrompt = buildCleanedPrompt(processedPrompt, mentionPositions);

  return {
    mentions: deduped,
    cleanedPrompt,
    hasExplicitRouting: true,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find ranges of backtick code blocks (both ``` and inline `). */
function findCodeBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Fenced code blocks: ```...```
  let idx = 0;
  while (idx < text.length) {
    const fenceStart = text.indexOf("```", idx);
    if (fenceStart === -1) break;
    const fenceEnd = text.indexOf("```", fenceStart + 3);
    if (fenceEnd === -1) {
      // Unclosed fence — treat rest as code
      ranges.push([fenceStart, text.length]);
      break;
    }
    ranges.push([fenceStart, fenceEnd + 3]);
    idx = fenceEnd + 3;
  }

  // Inline code: `...` (skip ranges already covered by fenced blocks)
  idx = 0;
  while (idx < text.length) {
    const tickStart = text.indexOf("`", idx);
    if (tickStart === -1) break;

    // Skip if inside a fenced block
    if (ranges.some(([s, e]) => tickStart >= s && tickStart < e)) {
      idx = tickStart + 1;
      continue;
    }

    // Check for ``` (already handled)
    if (text.slice(tickStart, tickStart + 3) === "```") {
      idx = tickStart + 3;
      continue;
    }

    const tickEnd = text.indexOf("`", tickStart + 1);
    if (tickEnd === -1) break;

    // Skip if the closing tick is inside a fenced block
    if (!ranges.some(([s, e]) => tickEnd >= s && tickEnd < e)) {
      ranges.push([tickStart, tickEnd + 1]);
    }
    idx = tickEnd + 1;
  }

  return ranges;
}

function isInCodeBlock(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

function deduplicateMentions(mentions: AgentMention[]): AgentMention[] {
  const seen = new Map<string, AgentMention>();

  for (const m of mentions) {
    const existing = seen.get(m.agentId);
    if (existing) {
      // Merge tasks
      if (m.task) {
        existing.task = existing.task
          ? `${existing.task} ${m.task}`
          : m.task;
      }
    } else {
      seen.set(m.agentId, { ...m });
    }
  }

  return [...seen.values()];
}

function buildCleanedPrompt(
  prompt: string,
  positions: Array<{ start: number; end: number }>,
): string {
  let result = "";
  let lastEnd = 0;

  for (const pos of positions) {
    result += prompt.slice(lastEnd, pos.start);
    lastEnd = pos.end;
  }
  result += prompt.slice(lastEnd);

  // Normalize whitespace
  return result.replace(/\s+/g, " ").trim();
}
