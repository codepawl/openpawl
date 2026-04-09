/**
 * Column alignment utilities — replace hardcoded padEnd patterns.
 */
import { visibleWidth } from "../utils/text-width.js";
import { truncate } from "../utils/truncate.js";

export interface ColumnDef {
  content: string;
  width?: number | "auto" | "fill";
  align?: "left" | "right";
  color?: (s: string) => string;
  maxWidth?: number;
}

export interface ColumnsOptions {
  totalWidth?: number;
  gap?: number;
  padding?: number;
}

/**
 * Render multiple columns in a single line.
 * - 'auto': uses the content's visible width
 * - 'fill': takes remaining space after fixed/auto columns
 * - number: exact column width
 */
export function columns(cols: ColumnDef[], options?: ColumnsOptions): string {
  const gap = options?.gap ?? 2;
  const pad = options?.padding ?? 0;
  const totalW = options?.totalWidth ?? 80;
  const gapStr = " ".repeat(gap);

  // Resolve widths
  const widths: number[] = [];
  let usedWidth = pad + gap * Math.max(0, cols.length - 1);
  let fillCount = 0;

  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    if (typeof col.width === "number") {
      widths[i] = col.width;
      usedWidth += col.width;
    } else if (col.width === "fill") {
      widths[i] = 0; // resolved below
      fillCount++;
    } else {
      // 'auto' or default
      const w = visibleWidth(col.content);
      const capped = col.maxWidth ? Math.min(w, col.maxWidth) : w;
      widths[i] = capped;
      usedWidth += capped;
    }
  }

  // Distribute remaining space to 'fill' columns
  if (fillCount > 0) {
    const remaining = Math.max(0, totalW - usedWidth);
    const perFill = Math.floor(remaining / fillCount);
    for (let i = 0; i < cols.length; i++) {
      if (cols[i]!.width === "fill") {
        widths[i] = perFill;
      }
    }
  }

  // Render each column
  const parts: string[] = [];
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    const w = widths[i]!;
    const content = col.color ? col.color(col.content) : col.content;
    const visW = visibleWidth(content);

    let cell: string;
    if (visW > w) {
      cell = truncate(content, w);
      const cellW = visibleWidth(cell);
      cell += " ".repeat(Math.max(0, w - cellW));
    } else if (col.align === "right") {
      cell = " ".repeat(w - visW) + content;
    } else {
      cell = content + " ".repeat(w - visW);
    }

    parts.push(cell);
  }

  return " ".repeat(pad) + parts.join(gapStr);
}

/**
 * Convenience for label:value pairs.
 */
export function labelValue(
  label: string,
  value: string,
  options?: {
    labelWidth?: number;
    totalWidth?: number;
    labelColor?: (s: string) => string;
    valueColor?: (s: string) => string;
    gap?: number;
  },
): string {
  const labelW = options?.labelWidth ?? visibleWidth(label);
  return columns(
    [
      { content: label, width: labelW, color: options?.labelColor },
      { content: value, width: "fill", color: options?.valueColor },
    ],
    { totalWidth: options?.totalWidth, gap: options?.gap ?? 2 },
  );
}
