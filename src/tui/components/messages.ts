/**
 * Messages component — scrollable chat message list.
 * Supports streaming append for token-by-token display.
 */
import type { Component } from "../core/component.js";
import type { LayoutConfig } from "../layout/responsive.js";
import { wrapText } from "../utils/wrap.js";
import { visibleWidth } from "../utils/text-width.js";
import { defaultTheme, ctp } from "../themes/default.js";
import { renderMarkdown } from "./markdown.js";
import { CopyManager } from "../text/copy-manager.js";

export interface ChatMessage {
  role: "user" | "assistant" | "agent" | "tool" | "system" | "error";
  content: string;
  agentName?: string;
  agentColor?: (s: string) => string;
  timestamp?: Date;
  collapsible?: boolean;
  collapsed?: boolean;
}

/** Lines above which a message is considered collapsible. */
const COLLAPSE_THRESHOLD = 15;
/** Number of preview lines shown when collapsed. */
const COLLAPSE_PREVIEW = 3;

export class MessagesComponent implements Component {
  readonly id: string;
  readonly focusable = true;
  hidden = false;

  private messages: ChatMessage[] = [];
  /** Line index where each message starts (into the rendered allLines array). */
  private messageBoundaries: number[] = [];
  private layoutProvider?: () => LayoutConfig;

  constructor(id: string) {
    this.id = id;
  }

  render(width: number): string[] {
    const allLines: string[] = [];
    const bubblePct = this.layoutProvider?.().messageBubblePercent ?? 0.70;
    const maxBubbleWidth = Math.min(Math.floor(width * bubblePct), width - 8);
    this.messageBoundaries = [];

    for (const msg of this.messages) {
      this.messageBoundaries.push(allLines.length);

      switch (msg.role) {
        case "user": {
          // RIGHT aligned bordered bubble
          const userMaxWidth = Math.min(Math.floor(width * 0.5), maxBubbleWidth);
          const wrapped = wrapText(msg.content || "", userMaxWidth - 4);
          const contentWidth = wrapped.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
          const boxWidth = contentWidth + 4; // border + padding each side
          const leftPad = " ".repeat(Math.max(0, width - boxWidth));

          const msgLines: string[] = [];
          msgLines.push(leftPad + ctp.surface1("┌" + "─".repeat(boxWidth - 2) + "┐"));
          for (const line of wrapped) {
            const padRight = contentWidth - visibleWidth(line);
            msgLines.push(leftPad + ctp.surface1("│") + " " + ctp.text(line) + " ".repeat(padRight) + " " + ctp.surface1("│"));
          }
          msgLines.push(leftPad + ctp.surface1("└" + "─".repeat(boxWidth - 2) + "┘"));

          this.pushMaybeCollapsed(allLines, msgLines, msg, width);
          break;
        }
        case "assistant":
        case "agent": {
          // LEFT aligned with colored accent border + markdown body
          const nameLabel = msg.agentName ?? msg.role;
          const nameFn = msg.agentColor ?? defaultTheme.agentName;
          const accentBorder = msg.agentColor ?? ctp.overlay2;

          const msgLines: string[] = [];
          msgLines.push("  " + accentBorder("┃") + " " + nameFn(`[${nameLabel}]`));
          const mdLines = renderMarkdown(msg.content || "", maxBubbleWidth - 4);
          for (const line of mdLines) {
            // Wrap in ctp.text() so plain paragraph text gets a readable color
            // (markdown elements like code/links already have their own colors)
            msgLines.push("  " + accentBorder("┃") + " " + ctp.text(line));
          }

          this.pushMaybeCollapsed(allLines, msgLines, msg, width);
          break;
        }
        case "error": {
          // LEFT aligned, red with prefix on first line only
          const wrapped = wrapText(msg.content || "", maxBubbleWidth - 4);
          for (let i = 0; i < wrapped.length; i++) {
            const prefix = i === 0 ? "✗ " : "  ";
            allLines.push("  " + defaultTheme.error(prefix + wrapped[i]));
          }
          break;
        }
        case "tool": {
          // LEFT aligned, overlay1 with teal icon
          const wrapped = wrapText(msg.content || "", maxBubbleWidth - 4);
          for (let i = 0; i < wrapped.length; i++) {
            const prefix = i === 0 ? ctp.teal("⚙ ") : "  ";
            allLines.push("  " + prefix + ctp.overlay1(wrapped[i]!));
          }
          break;
        }
        default: {
          // system and others — LEFT aligned
          // If content already has ANSI codes (pre-styled), pass through as-is.
          // Otherwise apply overlay1 color.
          const hasAnsi = (msg.content || "").includes("\x1b[");
          const colorFn = hasAnsi ? (s: string) => s : ctp.overlay1;
          const wrapped = wrapText(msg.content || "", maxBubbleWidth);
          for (const line of wrapped) {
            allLines.push("  " + colorFn(line));
          }
          break;
        }
      }
      allLines.push(""); // spacing between messages
    }

    return allLines;
  }

  /** Push message lines, applying collapse if needed. */
  private pushMaybeCollapsed(
    allLines: string[],
    msgLines: string[],
    msg: ChatMessage,
    _width: number,
  ): void {
    if (msgLines.length >= COLLAPSE_THRESHOLD) {
      msg.collapsible = true;
    }
    if (msg.collapsed && msg.collapsible) {
      const preview = msgLines.slice(0, COLLAPSE_PREVIEW);
      allLines.push(...preview);
      const hidden = msgLines.length - COLLAPSE_PREVIEW;
      allLines.push("  " + ctp.overlay0(`  ▸ ${hidden} more lines — Enter to expand`));
    } else {
      allLines.push(...msgLines);
    }
  }

  addMessage(msg: ChatMessage): void {
    // Auto-collapse previous long assistant/agent messages
    for (const prev of this.messages) {
      if (
        (prev.role === "assistant" || prev.role === "agent") &&
        prev.collapsible &&
        prev.collapsed === undefined
      ) {
        prev.collapsed = true;
      }
    }
    this.messages.push(msg);
  }

  /** Replace the last message's content entirely (for thinking indicator). */
  replaceLast(content: string): void {
    if (this.messages.length > 0) {
      this.messages[this.messages.length - 1]!.content = content;
    }
  }

  /** Replace the last message entirely (e.g., swap thinking for agent message). */
  replaceLastWith(msg: ChatMessage): void {
    if (this.messages.length > 0) {
      this.messages[this.messages.length - 1] = msg;
    } else {
      this.messages.push(msg);
    }
  }

  /** Append text to the last message (streaming). */
  appendToLast(chunk: string): void {
    if (this.messages.length === 0) {
      this.messages.push({ role: "assistant", content: chunk });
    } else {
      const last = this.messages[this.messages.length - 1]!;
      last.content += chunk;
    }
  }

  clear(): void {
    this.messages = [];
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  /** Copy the last agent/assistant message to clipboard. */
  async copyLastResponse(): Promise<boolean> {
    const copyMgr = new CopyManager();
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role === "agent" || msg.role === "assistant") {
        return copyMgr.copyMessage(msg.content);
      }
    }
    return false;
  }

  /** Get the content of the last agent response (for /copy). */
  setLayoutProvider(fn: () => LayoutConfig): void {
    this.layoutProvider = fn;
  }

  getLastResponse(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role === "agent" || msg.role === "assistant") return msg.content;
    }
    return null;
  }

  /** Toggle collapsed state for a message by index. Returns true if toggled. */
  toggleCollapse(index: number): boolean {
    const msg = this.messages[index];
    if (!msg || !msg.collapsible) return false;
    msg.collapsed = !msg.collapsed;
    return true;
  }

  /** Collapse all collapsible messages. */
  collapseAll(): void {
    for (const msg of this.messages) {
      if (msg.collapsible) msg.collapsed = true;
    }
  }

  /** Get rendered line indices where each user message starts (for prompt navigation). */
  getPromptBoundaries(): { lineIndex: number; messageIndex: number }[] {
    const result: { lineIndex: number; messageIndex: number }[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]!.role === "user" && this.messageBoundaries[i] !== undefined) {
        result.push({ lineIndex: this.messageBoundaries[i]!, messageIndex: i });
      }
    }
    return result;
  }

  /** Get total number of user prompts. */
  getPromptCount(): number {
    return this.messages.filter((m) => m.role === "user").length;
  }

  /** Find which message index corresponds to a given rendered line index. */
  getMessageAtLine(lineIndex: number): number {
    for (let i = this.messageBoundaries.length - 1; i >= 0; i--) {
      if (this.messageBoundaries[i]! <= lineIndex) return i;
    }
    return 0;
  }
}
