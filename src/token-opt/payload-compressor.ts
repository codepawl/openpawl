/**
 * Payload compressor — truncates large text payloads before prompt injection.
 *
 * Used to prevent planning_document, preferences_context, and similar
 * GraphState fields from bloating agent prompts beyond useful context.
 */

import { recordPayloadTruncation } from "./stats.js";

const DEFAULT_THRESHOLD = 2000;

/**
 * Truncate text exceeding `thresholdChars` and append a marker.
 * Returns the original text unchanged if below the threshold.
 */
export function compressIfLarge(
  text: string,
  thresholdChars = DEFAULT_THRESHOLD,
): { text: string; truncatedBy: number } {
  if (!text || text.length <= thresholdChars) {
    return { text, truncatedBy: 0 };
  }

  const truncatedBy = text.length - thresholdChars;
  const compressed = `${text.slice(0, thresholdChars)}\n[truncated: ${truncatedBy} chars omitted]`;
  recordPayloadTruncation(truncatedBy);
  return { text: compressed, truncatedBy };
}
