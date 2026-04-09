/**
 * Modal overlay — renders its child component centered in a bordered panel.
 */
import type { Component } from "../core/component.js";
import type { KeyEvent } from "../core/input.js";
import { renderPanel } from "./panel.js";

export class OverlayComponent implements Component {
  readonly id: string;
  private child: Component;
  private width: number;

  constructor(id: string, child: Component, width = 60) {
    this.id = id;
    this.child = child;
    this.width = width;
  }

  render(termWidth: number): string[] {
    const contentWidth = Math.min(this.width, termWidth - 4);
    const childLines = this.child.render(contentWidth);

    return renderPanel({
      width: contentWidth + 4, // add border + padding
      termWidth,
      align: "center",
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
    }, childLines);
  }

  onKey(event: KeyEvent): boolean {
    return this.child.onKey?.(event) ?? false;
  }

  getChild(): Component {
    return this.child;
  }
}
