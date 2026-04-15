/**
 * Defensive JSON parser for noisy LLM outputs.
 * Layered recovery: direct parse → strip fences → extract brackets →
 * strip XML/think tags → repair truncated JSON → fallback.
 */

import { logger, isDebugMode } from "../core/logger.js";
import { debugLog, isDebugEnabled } from "../debug/logger.js";

export type SafeParseResult<T> =
  | { data: T; parsed: true }
  | { error: string; parsed: false };

/**
 * Attempt to parse JSON from potentially noisy LLM output.
 * Returns a discriminated union — never throws.
 */
export function safeJsonParse<T>(raw: string): SafeParseResult<T> {
  if (!raw || !raw.trim()) {
    return { error: "empty input", parsed: false };
  }

  // Layer 1: direct parse
  try {
    const data = JSON.parse(raw) as T;
    if (isDebugEnabled()) debugLog("debug", "error", "json_parse:success", { data: { layer: 1 } });
    return { data, parsed: true };
  } catch { /* continue */ }

  let cleaned = raw;

  // Layer 2: strip <think>...</think> blocks (reasoning models)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Layer 3: strip XML-like tool call wrappers (minimax/some providers)
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
  cleaned = cleaned.replace(/<\/?[a-z_]+>/gi, "").trim();

  if (cleaned !== raw) {
    try {
      const data = JSON.parse(cleaned) as T;
      if (isDebugEnabled()) debugLog("info", "error", "json_parse:recovery", { data: { layer: 3, inputPreview: raw.slice(0, 100) } });
      return { data, parsed: true };
    } catch { /* continue */ }
  }

  // Layer 4: extract from fenced code block
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const data = JSON.parse(fenceMatch[1]!.trim()) as T;
      if (isDebugEnabled()) debugLog("info", "error", "json_parse:recovery", { data: { layer: 4, inputPreview: raw.slice(0, 100) } });
      return { data, parsed: true };
    } catch { /* continue */ }
  }

  // Layer 5: extract first balanced { } or [ ] block
  const extracted = extractJsonBlock(cleaned);
  if (extracted) {
    try {
      const data = JSON.parse(extracted) as T;
      if (isDebugEnabled()) debugLog("info", "error", "json_parse:recovery", { data: { layer: 5, inputPreview: raw.slice(0, 100) } });
      return { data, parsed: true };
    } catch { /* continue */ }

    // Layer 6: try repairing truncated JSON (unclosed strings/brackets)
    const repaired = repairTruncatedJson(extracted);
    if (repaired !== extracted) {
      try {
        const data = JSON.parse(repaired) as T;
        if (isDebugEnabled()) debugLog("info", "error", "json_parse:recovery", { data: { layer: 6, inputPreview: raw.slice(0, 100) } });
        return { data, parsed: true };
      } catch { /* continue */ }
    }
  }

  // All layers failed
  const preview = raw.slice(0, 200).replace(/\n/g, "\\n");
  if (isDebugMode()) {
    logger.warn(`safeJsonParse failed. Preview: ${preview}`);
  }
  if (isDebugEnabled()) {
    debugLog("error", "error", "json_parse:all_failed", {
      data: { inputLength: raw.length, inputPreview: raw.slice(0, 100) },
    });
  }
  return { error: `JSON parse failed. Preview: ${preview}`, parsed: false };
}

/**
 * Extract the first top-level JSON block ({ ... } or [ ... ]) from text.
 * Handles nested braces/brackets correctly.
 */
function extractJsonBlock(text: string): string | null {
  let start = -1;
  let openChar = "";
  let closeChar = "";

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      start = i;
      openChar = text[i]!;
      closeChar = openChar === "{" ? "}" : "]";
      break;
    }
  }

  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Unclosed — return what we have (will likely fail parse but repair can fix it)
  return text.slice(start);
}

/**
 * Attempt to repair truncated JSON by closing unclosed strings and brackets.
 */
function repairTruncatedJson(json: string): string {
  let result = json.trimEnd();

  // Remove trailing comma
  result = result.replace(/,\s*$/, "");

  // Track what needs closing
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < result.length; i++) {
    const ch = result[i]!;

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // Close unclosed string
  if (inString) result += '"';

  // Close unclosed brackets/braces
  while (stack.length > 0) {
    result += stack.pop();
  }

  return result;
}
