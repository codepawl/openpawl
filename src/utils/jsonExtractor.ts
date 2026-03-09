/**
 * Helpers for extracting JSON from noisy LLM outputs.
 */

export function parseLlmJson<T>(text: string): T {
  const source = text ?? "";

  // 1) Strip <think>...</think> blocks (reasoning models).
  let cleaned = source.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2) Extract from fenced code block if present (```json ... ``` or ``` ... ```).
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/i;
  const fenceMatch = fenceRegex.exec(cleaned);
  let candidate = fenceMatch ? fenceMatch[1].trim() : cleaned;

  // 3) Boundary fallback: take substring from first {/[ to last }/].
  if (!fenceMatch) {
    const firstBrace = candidate.indexOf("{");
    const firstBracket = candidate.indexOf("[");
    const startCandidates = [firstBrace, firstBracket].filter((i) => i >= 0);
    const start = startCandidates.length > 0 ? Math.min(...startCandidates) : -1;

    const lastBrace = candidate.lastIndexOf("}");
    const lastBracket = candidate.lastIndexOf("]");
    const endCandidates = [lastBrace, lastBracket].filter((i) => i >= 0);
    const end = endCandidates.length > 0 ? Math.max(...endCandidates) + 1 : -1;

    if (start >= 0 && end > start) {
      candidate = candidate.slice(start, end).trim();
    }
  }

  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse LLM JSON response: ${message}. Extracted candidate: ${candidate.slice(
        0,
        500,
      )}`,
    );
  }
}

