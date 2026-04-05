/**
 * Messages component — scrollable chat message list.
 * Supports streaming append for token-by-token display.
 */
import type { Component } from "../core/component.js";
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

export class MessagesComponent implements Component {
  readonly id: string;
  readonly focusable = true;

  private messages: ChatMessage[] = [];

  constructor(id: string) {
    this.id = id;
  }

  render(width: number): string[] {
    const allLines: string[] = [];
    const maxBubbleWidth = Math.min(Math.floor(width * 0.70), width - 8);

    for (const msg of this.messages) {
      switch (msg.role) {
        case "user": {
          // RIGHT aligned bordered bubble
          const userMaxWidth = Math.min(Math.floor(width * 0.5), maxBubbleWidth);
          const wrapped = wrapText(msg.content || "", userMaxWidth - 4);
          const contentWidth = wrapped.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
          const boxWidth = contentWidth + 4; // border + padding each side
          const leftPad = " ".repeat(Math.max(0, width - boxWidth));

          allLines.push(leftPad + ctp.surface1("┌" + "─".repeat(boxWidth - 2) + "┐"));
          for (const line of wrapped) {
            const padRight = contentWidth - visibleWidth(line);
            allLines.push(leftPad + ctp.surface1("│") + " " + ctp.text(line) + " ".repeat(padRight) + " " + ctp.surface1("│"));
          }
          allLines.push(leftPad + ctp.surface1("└" + "─".repeat(boxWidth - 2) + "┘"));
          break;
        }
        case "assistant":
        case "agent": {
          // LEFT aligned with colored accent border + markdown body
          const nameLabel = msg.agentName ?? msg.role;
          const nameFn = msg.agentColor ?? defaultTheme.agentName;
          const accentBorder = msg.agentColor ?? ctp.overlay2;

          allLines.push("  " + accentBorder("┃") + " " + nameFn(`[${nameLabel}]`));
          const mdLines = renderMarkdown(msg.content || "", maxBubbleWidth - 4);
          for (const line of mdLines) {
            allLines.push("  " + accentBorder("┃") + " " + line);
          }
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

  addMessage(msg: ChatMessage): void {
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
  getLastResponse(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role === "agent" || msg.role === "assistant") return msg.content;
    }
    return null;
  }
}
