/**
 * Horizontal separator line with optional centered label.
 */
import { visibleWidth } from "../utils/text-width.js";
import { ctp } from "../themes/default.js";

export interface SeparatorOptions {
  width?: number;
  char?: string;
  label?: string;
  labelAlign?: "left" | "center" | "right";
  color?: (s: string) => string;
  padding?: number;
}

export function separator(options?: SeparatorOptions): string {
  const w = options?.width ?? 40;
  const ch = options?.char ?? "\u2500";
  const color = options?.color ?? ctp.surface1;
  const pad = options?.padding ?? 0;
  const padStr = " ".repeat(pad);

  if (!options?.label) {
    return padStr + color(ch.repeat(w));
  }

  const label = ` ${options.label} `;
  const labelW = visibleWidth(label);
  const align = options?.labelAlign ?? "center";
  const fillTotal = Math.max(0, w - labelW);

  let left: number;
  let right: number;
  if (align === "left") {
    left = 2;
    right = fillTotal - 2;
  } else if (align === "right") {
    right = 2;
    left = fillTotal - 2;
  } else {
    left = Math.floor(fillTotal / 2);
    right = fillTotal - left;
  }

  return padStr + color(ch.repeat(Math.max(0, left))) + color(label) + color(ch.repeat(Math.max(0, right)));
}
