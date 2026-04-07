/**
 * Component model — retained-mode line-based rendering.
 * Components render themselves as arrays of terminal lines.
 */
import type { KeyEvent } from "./input.js";

/** Base interface for all TUI components. */
export interface Component {
  /** Unique ID used for diffing and lookup. */
  readonly id: string;

  /**
   * Render this component as an array of terminal lines.
   * Each line is a string that may contain ANSI escape codes.
   * Called by the renderer on each frame where the component is visible.
   */
  render(width: number): string[];

  /** Whether this component can receive keyboard focus. */
  focusable?: boolean;

  /** Handle keyboard input when focused. Return true if the event was consumed. */
  onKey?(event: KeyEvent): boolean;

  /** Called when this component gains focus. */
  onFocus?(): void;

  /** Called when this component loses focus. */
  onBlur?(): void;

  /** Called when the component is added to the tree. */
  onMount?(): void;

  /** Called when the component is removed from the tree. */
  onUnmount?(): void;

  /** Return cursor position relative to this component's rendered output (1-based row/col). */
  getCursorPosition?(): { row: number; col: number } | null;

  /** When true, component is skipped during rendering. */
  hidden?: boolean;
}

/**
 * Container — a component that renders its children top-to-bottom.
 * Used as the root of the component tree and for grouping.
 */
export class Container implements Component {
  readonly id: string;
  readonly children: Component[] = [];

  constructor(id: string) {
    this.id = id;
  }

  render(width: number): string[] {
    return this.children.flatMap((c) => c.render(width));
  }

  /** Add a child component to the end. */
  add(child: Component): void {
    this.children.push(child);
    child.onMount?.();
  }

  /** Insert a child at a specific index. */
  insertAt(index: number, child: Component): void {
    this.children.splice(index, 0, child);
    child.onMount?.();
  }

  /** Remove a child by ID. Returns true if found. */
  remove(id: string): boolean {
    const idx = this.children.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    const [removed] = this.children.splice(idx, 1);
    removed!.onUnmount?.();
    return true;
  }

  /** Get a child by ID. */
  get(id: string): Component | undefined {
    return this.children.find((c) => c.id === id);
  }

  /** Remove all children. */
  clear(): void {
    for (const child of this.children) {
      child.onUnmount?.();
    }
    this.children.length = 0;
  }
}
