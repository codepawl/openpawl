/**
 * Generate a display name for a session from goal text or first user message.
 * Pure function — truncates at word boundary, strips common prefixes.
 */

const MAX_LENGTH = 40;
const MIN_WORD_BREAK = 15;

const PREFIX_PATTERN = /^(help me |please |i want to |can you |i need to |build me |make me |create me )/i;

/**
 * Generate a session display name from input text (goal or first message).
 * - Strips common conversational prefixes
 * - Truncates to ~40 chars at a word boundary
 * - Returns "Untitled session" for empty/whitespace-only input
 */
export function generateSessionName(input: string): string {
  let cleaned = input.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(PREFIX_PATTERN, "").trim();

  if (!cleaned) return "Untitled session";

  // Capitalize first letter
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

  if (cleaned.length <= MAX_LENGTH) return cleaned;

  const truncated = cleaned.slice(0, MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > MIN_WORD_BREAK ? lastSpace : MAX_LENGTH;
  return truncated.slice(0, cutPoint) + "...";
}
