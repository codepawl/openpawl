/**
 * Hebbian-memory injection block per spec §5.8.
 *
 * Each crew agent receives, alongside the known-files block, a markdown
 * summary of the top-K Hebbian-weighted associations relevant to the
 * task description. The agents read it; the runner does not transform.
 *
 * Implementation strategy:
 *   - Production callers wire `recall` to a real HebbianMemory query
 *     (the recall path needs a vector seed, which today comes from
 *     LanceDB — that wiring lands in the runtime-integration PR after
 *     this one). The function takes `recall` as an optional callback
 *     so this module is unit-testable without a database.
 *   - When env `OPENPAWL_HEBBIAN_INJECT === "false"`, return empty.
 *   - When `recall` is undefined OR returns no results, return empty.
 *   - Otherwise format a sorted markdown block, capped at the
 *     configured token budget (default 500 tokens via the 4-chars-per-
 *     token heuristic). Excess entries are dropped from the tail.
 */

import { debugLog } from "../debug/logger.js";
import type { CrewTask } from "./types.js";

export const DEFAULT_HEBBIAN_TOKEN_CAP = 500;
export const DEFAULT_TOP_K = 5;
const TOKEN_HEURISTIC = (text: string): number => Math.ceil(text.length / 4);

export interface HebbianRecallResult {
  content: string;
  strength: number;
  /** Optional category from the upstream HebbianMemory module. */
  category?: string;
}

export type HebbianRecaller = (args: {
  task_description: string;
  top_k: number;
}) => Promise<HebbianRecallResult[]>;

export interface BuildHebbianBlockArgs {
  task: CrewTask;
  recall?: HebbianRecaller;
  /** Max tokens the rendered block may consume. Defaults to {@link DEFAULT_HEBBIAN_TOKEN_CAP}. */
  token_cap?: number;
  /** Top-K to request from the recaller. Defaults to {@link DEFAULT_TOP_K}. */
  top_k?: number;
}

function isInjectionEnabled(): boolean {
  const flag = process.env.OPENPAWL_HEBBIAN_INJECT;
  if (flag === undefined) return true;
  return flag !== "false" && flag !== "0";
}

function formatStrength(strength: number): string {
  return strength.toFixed(2);
}

function renderEntry(entry: HebbianRecallResult): string {
  const line = `- ${entry.content} _(strength: ${formatStrength(entry.strength)})_`;
  // Single-line entry; multi-line content collapsed to keep the block dense.
  return line.replace(/\s+/g, " ").trim();
}

export async function buildHebbianBlock(
  args: BuildHebbianBlockArgs,
): Promise<string> {
  if (!isInjectionEnabled()) return "";
  if (!args.recall) return "";

  const tokenCap = args.token_cap ?? DEFAULT_HEBBIAN_TOKEN_CAP;
  const topK = args.top_k ?? DEFAULT_TOP_K;

  let results: HebbianRecallResult[];
  try {
    results = await args.recall({
      task_description: args.task.description,
      top_k: topK,
    });
  } catch (err) {
    debugLog("warn", "crew", "hebbian:recall_failed", {
      data: { task_id: args.task.id },
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }

  if (!Array.isArray(results) || results.length === 0) return "";

  const sorted = results.slice().sort((a, b) => b.strength - a.strength);
  const lines = ["## Relevant context (Hebbian memory)"];
  for (const entry of sorted) {
    if (
      typeof entry?.content !== "string" ||
      entry.content.length === 0 ||
      typeof entry.strength !== "number"
    ) {
      continue;
    }
    lines.push(renderEntry(entry));
  }

  if (lines.length === 1) return ""; // header only — nothing renderable

  // Token cap: drop tail entries until rendered block fits.
  while (lines.length > 2 && TOKEN_HEURISTIC(lines.join("\n")) > tokenCap) {
    lines.pop();
  }

  // If even one entry doesn't fit the cap, return empty rather than
  // half a block — the prompt is cleaner without a misleading header.
  if (TOKEN_HEURISTIC(lines.join("\n")) > tokenCap) return "";

  return lines.join("\n");
}
