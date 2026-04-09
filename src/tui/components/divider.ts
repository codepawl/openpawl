/**
 * Horizontal divider line with optional dynamic label.
 */
import type { Component } from "../core/component.js";
import type { StyleFn } from "../themes/theme.js";
import { ctp } from "../themes/default.js";
import { separator } from "../primitives/separator.js";

export class DividerComponent implements Component {
  readonly id: string;
  hidden = false;
  private char: string;
  private style: StyleFn;
  private label: string | null = null;

  constructor(id: string, char = "\u2500", style: StyleFn = ctp.surface1) {
    this.id = id;
    this.char = char;
    this.style = style;
  }

  /** Set a dynamic label shown centered in the divider (e.g. "prompt 3/7"). */
  setLabel(label: string | null): void {
    this.label = label;
  }

  render(width: number): string[] {
    return [separator({
      width,
      char: this.char,
      label: this.label ?? undefined,
      color: this.style,
    })];
  }
}
