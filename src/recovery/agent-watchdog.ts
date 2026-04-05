/**
 * Agent watchdog — detect stuck/looping agents.
 */

export interface WatchdogHandle {
  feedToken(token: string): void;
  feedToolCall(toolName: string): void;
  shouldStop(): StopReason | null;
  dispose(): void;
}

export type StopReason =
  | { type: "stuck"; reason: string; repeatedContent: string }
  | { type: "tool_loop"; iterations: number }
  | { type: "no_progress"; silentSeconds: number }
  | { type: "output_too_large"; bytes: number };

const MAX_OUTPUT_BYTES = 100_000;
const NO_PROGRESS_TIMEOUT_MS = 60_000;
const CHUNK_SIZE = 200; // tokens per chunk for similarity check

export class AgentWatchdog {
  watch(_agentId: string, _sessionId: string): WatchdogHandle {
    const chunks: string[] = [];
    let currentChunk = "";
    let totalBytes = 0;
    let lastActivityAt = Date.now();
    const toolCalls = new Map<string, number>(); // tool+args → count

    return {
      feedToken(token: string): void {
        currentChunk += token;
        totalBytes += token.length;
        lastActivityAt = Date.now();

        if (currentChunk.length >= CHUNK_SIZE) {
          chunks.push(currentChunk);
          if (chunks.length > 5) chunks.shift(); // Keep last 5
          currentChunk = "";
        }
      },

      feedToolCall(toolName: string): void {
        lastActivityAt = Date.now();
        const key = toolName;
        toolCalls.set(key, (toolCalls.get(key) ?? 0) + 1);
      },

      shouldStop(): StopReason | null {
        // Output too large
        if (totalBytes > MAX_OUTPUT_BYTES) {
          return { type: "output_too_large", bytes: totalBytes };
        }

        // No progress
        const silent = Date.now() - lastActivityAt;
        if (silent > NO_PROGRESS_TIMEOUT_MS) {
          return { type: "no_progress", silentSeconds: Math.floor(silent / 1000) };
        }

        // Stuck detection: 3 similar chunks
        if (chunks.length >= 3) {
          const last3 = chunks.slice(-3);
          const sim01 = jaccardSimilarity(last3[0]!, last3[1]!);
          const sim12 = jaccardSimilarity(last3[1]!, last3[2]!);
          if (sim01 > 0.9 && sim12 > 0.9) {
            return { type: "stuck", reason: "Agent repeating itself", repeatedContent: last3[2]!.slice(0, 100) };
          }
        }

        // Same tool called 3+ times
        for (const count of toolCalls.values()) {
          if (count >= 3) {
            return { type: "tool_loop", iterations: count };
          }
        }

        return null;
      },

      dispose(): void {
        chunks.length = 0;
        toolCalls.clear();
      },
    };
  }
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
