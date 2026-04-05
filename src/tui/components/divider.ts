/**
 * Horizontal divider line.
 */
import type { Component } from "../core/component.js";
import type { StyleFn } from "../themes/theme.js";
import { ctp } from "../themes/default.js";

export class DividerComponent implements Component {
  readonly id: string;
  private char: string;
  private style: StyleFn;

  constructor(id: string, char = "─", style: StyleFn = ctp.surface1) {
    this.id = id;
    this.char = char;
    this.style = style;
  }

  render(width: number): string[] {
    return [this.style(this.char.repeat(width))];
  }
}
