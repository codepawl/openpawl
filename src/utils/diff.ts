/**
 * Line-based diff engine for inline file change display.
 * Uses LCS (Longest Common Subsequence) — no external dependencies.
 */

export interface DiffLine {
  type: "added" | "removed" | "context" | "collapsed";
  content: string;
}

export interface DiffResult {
  added: number;
  removed: number;
  lines: DiffLine[];
}

const MAX_COMBINED_CHARS = 100_000;
const MAX_DISPLAY_LINES = 500;
const NEW_FILE_PREVIEW = 15;
const CONTEXT_LINES = 3;

/** Detect binary content by checking for null bytes. */
function isBinary(content: string): boolean {
  const sample = content.slice(0, 512);
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * Compute LCS table for two line arrays.
 * Returns a 2D table where lcs[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 */
function lcsTable(a: string[], b: string[]): Uint16Array[] {
  const m = a.length;
  const n = b.length;
  // Use two rows to save memory
  const prev = new Uint16Array(n + 1);
  const curr = new Uint16Array(n + 1);
  const table: Uint16Array[] = [new Uint16Array(prev)];

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1]! + 1;
      } else {
        curr[j] = Math.max(prev[j]!, curr[j - 1]!);
      }
    }
    table.push(new Uint16Array(curr));
    prev.set(curr);
    curr.fill(0);
  }

  return table;
}

/** Backtrack LCS table to produce a sequence of diff operations. */
function backtrack(
  table: Uint16Array[],
  a: string[],
  b: string[],
): Array<{ type: "equal" | "added" | "removed"; line: string }> {
  const ops: Array<{ type: "equal" | "added" | "removed"; line: string }> = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", line: a[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i]![j]! > table[i]![j - 1]! ? false : true)) {
      ops.push({ type: "added", line: b[j - 1]! });
      j--;
    } else {
      ops.push({ type: "removed", line: a[i - 1]! });
      i--;
    }
  }

  return ops.reverse();
}

/** Group diff operations into hunks with context lines. */
function buildHunks(
  ops: Array<{ type: "equal" | "added" | "removed"; line: string }>,
): DiffLine[] {
  // Find change regions
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== "equal") changeIndices.push(i);
  }

  if (changeIndices.length === 0) return [];

  // Build visible ranges (change + context lines)
  const visible = new Set<number>();
  for (const idx of changeIndices) {
    for (let c = Math.max(0, idx - CONTEXT_LINES); c <= Math.min(ops.length - 1, idx + CONTEXT_LINES); c++) {
      visible.add(c);
    }
  }

  const lines: DiffLine[] = [];
  let lastEmitted = -1;

  for (let i = 0; i < ops.length; i++) {
    if (!visible.has(i)) continue;

    // Collapse gap between visible ranges
    if (i > lastEmitted + 1 && lastEmitted >= 0) {
      const skipped = i - lastEmitted - 1;
      if (skipped > 0) {
        lines.push({ type: "collapsed", content: `${skipped} unchanged lines` });
      }
    }

    const op = ops[i]!;
    if (op.type === "equal") {
      lines.push({ type: "context", content: op.line });
    } else if (op.type === "added") {
      lines.push({ type: "added", content: op.line });
    } else {
      lines.push({ type: "removed", content: op.line });
    }

    lastEmitted = i;
  }

  // Leading collapse
  if (changeIndices[0]! > CONTEXT_LINES) {
    const skipped = changeIndices[0]! - CONTEXT_LINES;
    lines.unshift({ type: "collapsed", content: `${skipped} unchanged lines` });
  }

  // Trailing collapse
  const lastChange = changeIndices[changeIndices.length - 1]!;
  const trailingEqual = ops.length - 1 - lastChange - CONTEXT_LINES;
  if (trailingEqual > 0) {
    lines.push({ type: "collapsed", content: `${trailingEqual} unchanged lines` });
  }

  return lines;
}

/**
 * Generate a line-based diff between before and after content.
 *
 * - New files (before = ""): first 15 lines as added, rest collapsed
 * - Binary files: counts only
 * - Large files (> 500 lines combined or > 100k chars): counts only
 * - Normal edits: unified diff with 3 lines context
 */
export function generateDiff(before: string, after: string): DiffResult {
  // Binary detection
  if (isBinary(before) || isBinary(after)) {
    const bLines = before ? before.split("\n").length : 0;
    const aLines = after.split("\n").length;
    return { added: aLines, removed: bLines, lines: [] };
  }

  // Size guard
  if (before.length + after.length > MAX_COMBINED_CHARS) {
    const bLines = before ? before.split("\n").length : 0;
    const aLines = after.split("\n").length;
    return { added: aLines, removed: bLines, lines: [] };
  }

  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after.split("\n");

  // Count-only for very large files
  if (beforeLines.length + afterLines.length > MAX_DISPLAY_LINES) {
    return { added: afterLines.length, removed: beforeLines.length, lines: [] };
  }

  // New file: preview first N lines
  if (beforeLines.length === 0 || (beforeLines.length === 1 && beforeLines[0] === "")) {
    const preview = afterLines.slice(0, NEW_FILE_PREVIEW);
    const lines: DiffLine[] = preview.map((l) => ({ type: "added" as const, content: l }));
    const remaining = afterLines.length - NEW_FILE_PREVIEW;
    if (remaining > 0) {
      lines.push({ type: "collapsed", content: `+${remaining} more lines` });
    }
    return { added: afterLines.length, removed: 0, lines };
  }

  // Compute LCS diff
  const table = lcsTable(beforeLines, afterLines);
  const ops = backtrack(table, beforeLines, afterLines);

  // Count changes
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "added") added++;
    if (op.type === "removed") removed++;
  }

  if (added === 0 && removed === 0) {
    return { added: 0, removed: 0, lines: [] };
  }

  const lines = buildHunks(ops);
  return { added, removed, lines };
}
