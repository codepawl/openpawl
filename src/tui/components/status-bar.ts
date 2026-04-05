/**
 * Status bar — fixed bar displaying segmented information.
 * Each segment can have its own color. Segments are separated by │.
 */
import type { Component } from "../core/component.js";
import { visibleWidth } from "../utils/text-width.js";
import { truncate } from "../utils/truncate.js";

export interface StatusSegment {
  text: string;
  color?: (s: string) => string;
}

export class StatusBarComponent implements Component {
  readonly id: string;
  private leftItems: string[] = [];
  private rightItems: string[] = [];
  private segments: StatusSegment[] | null = null;
  private rightText = "";
  private style: (s: string) => string;

  constructor(id: string, style?: (s: string) => string) {
    this.id = id;
    this.style = style ?? ((s) => `\x1b[7m${s}\x1b[27m`); // inverse by default
  }

  render(width: number): string[] {
    // Segment-based rendering (new API)
    if (this.segments) {
      return [this.renderSegments(width)];
    }

    // Legacy item-based rendering
    const left = this.leftItems.join("  ");
    const right = this.rightItems.join("  ");

    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const gap = Math.max(1, width - leftWidth - rightWidth);

    let bar: string;
    if (leftWidth + rightWidth + 1 > width) {
      bar = truncate(left, width - rightWidth - 1) + " " + right;
    } else {
      bar = left + " ".repeat(gap) + right;
    }

    const barWidth = visibleWidth(bar);
    if (barWidth < width) {
      bar += " ".repeat(width - barWidth);
    }

    return [this.style(bar)];
  }

  private renderSegments(width: number): string {
    const separator = " \u2502 ";
    const segments = this.segments!;
    const right = this.rightText ? this.rightText + " " : "";
    const rightWidth = visibleWidth(right);

    const leftParts = segments.map((s) =>
      s.color ? s.color(s.text) : s.text,
    );
    const left = " " + leftParts.join(separator);

    const leftPlain = segments.map((s) => s.text).join(separator);
    const leftWidth = visibleWidth(leftPlain) + 1; // +1 for leading space

    // Overflow: truncate left side to fit
    if (leftWidth + rightWidth + 1 > width) {
      const availableForLeft = Math.max(4, width - rightWidth - 1);
      const truncatedLeft = truncate(left, availableForLeft);
      const truncLeftWidth = visibleWidth(truncatedLeft);
      const padding = Math.max(1, width - truncLeftWidth - rightWidth);
      const bar = truncatedLeft + " ".repeat(padding) + right;
      const barWidth = visibleWidth(bar);
      const padded = barWidth < width ? bar + " ".repeat(width - barWidth) : bar;
      return this.style(padded);
    }

    const padding = Math.max(1, width - leftWidth - rightWidth);
    const bar = left + " ".repeat(padding) + right;
    const barWidth = visibleWidth(bar);
    const padded = barWidth < width ? bar + " ".repeat(width - barWidth) : bar;

    return this.style(padded);
  }

  /** Set styled segments (new API). */
  setSegments(segments: StatusSegment[]): void {
    this.segments = segments;
  }

  /** Update a single segment by index. */
  updateSegment(index: number, text: string, color?: (s: string) => string): void {
    if (this.segments && this.segments[index]) {
      this.segments[index]!.text = text;
      if (color) this.segments[index]!.color = color;
    }
  }

  /** Set the right-side text (used with segments). */
  setRightText(text: string): void {
    this.rightText = text;
  }

  // ── Legacy API (backward compatible) ──

  setLeft(...items: string[]): void {
    this.leftItems = items;
  }

  setRight(...items: string[]): void {
    this.rightItems = items;
  }
}
