/**
 * Parses confidence self-report blocks from agent output.
 */

import type { ConfidenceScore, ConfidenceFlag } from "./types.js";
import { KNOWN_FLAGS } from "./types.js";

const CONFIDENCE_REGEX = /<confidence>([\s\S]*?)<\/confidence>/g;

export interface ParsedConfidence {
  confidence: ConfidenceScore;
  cleanedOutput: string;
}

/**
 * Parse a `<confidence>` block from raw agent output.
 * Returns the extracted score and the output with the block stripped.
 * Never throws — returns safe defaults when absent or malformed.
 */
export function parseConfidence(rawOutput: string): ParsedConfidence {
  const matches = [...rawOutput.matchAll(CONFIDENCE_REGEX)];

  if (matches.length === 0) {
    return {
      confidence: { score: 0.5, reasoning: "No confidence block provided", flags: ["missing_context"] },
      cleanedOutput: rawOutput,
    };
  }

  // Take the last match
  const lastMatch = matches[matches.length - 1];
  const block = lastMatch[1];

  const score = parseScore(block);
  const reasoning = parseField(block, "reasoning") || "No reasoning provided";
  const flags = parseFlags(block);

  // Strip all confidence blocks from output
  const cleanedOutput = rawOutput.replace(CONFIDENCE_REGEX, "").trim();

  return {
    confidence: { score, reasoning, flags },
    cleanedOutput,
  };
}

function parseScore(block: string): number {
  const match = block.match(/score:\s*(-?[\d.]+)/i);
  if (!match) return 0.5;
  const val = Number.parseFloat(match[1]);
  if (!Number.isFinite(val)) return 0.5;
  return Math.max(0, Math.min(1, val));
}

function parseField(block: string, field: string): string {
  const match = block.match(new RegExp(`${field}:\\s*(.+?)(?:\\n|$)`, "i"));
  return match ? match[1].trim() : "";
}

function parseFlags(block: string): ConfidenceFlag[] {
  const match = block.match(/flags:\s*(.+?)(?:\n|$)/i);
  if (!match) return [];
  const raw = match[1].trim();
  const candidates = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const valid = candidates.filter((f) => KNOWN_FLAGS.has(f)) as ConfidenceFlag[];
  return valid.length > 0 ? valid : [];
}
