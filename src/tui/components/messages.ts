/**
 * Messages component — scrollable chat message list.
 * Supports streaming append for token-by-token display.
 */
import type { Component } from "../core/component.js";
import { wrapText } from "../utils/wrap.js";
import { visibleWidth } from "../utils/text-width.js";
import { defaultTheme } from "../themes/default.js";

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
          // RIGHT aligned, colored background bubble
          const wrapped = wrapText(msg.content || "", maxBubbleWidth - 2);
          const contentWidth = wrapped.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
          const bubbleWidth = contentWidth + 2; // 1 char padding each side
          for (const line of wrapped) {
            const padRight = contentWidth - visibleWidth(line);
            const padded = ` ${line}${" ".repeat(padRight)} `;
            const bubble = defaultTheme.userBubble(padded);
            const leftPad = " ".repeat(Math.max(0, width - bubbleWidth - 1));
            allLines.push(leftPad + bubble);
          }
          break;
        }
        case "assistant":
        case "agent": {
          // LEFT aligned, with agent name label
          const nameLabel = msg.agentName ?? msg.role;
          const nameFn = msg.agentColor ?? defaultTheme.agentName;
          allLines.push("  " + nameFn(nameLabel));
          const wrapped = wrapText(msg.content || "", maxBubbleWidth);
          for (const line of wrapped) {
            allLines.push("  " + line);
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
          // LEFT aligned, dim with wrapping
          const wrapped = wrapText(msg.content || "", maxBubbleWidth - 4);
          for (let i = 0; i < wrapped.length; i++) {
            const prefix = i === 0 ? "⚙ " : "  ";
            allLines.push("  " + defaultTheme.dim(prefix + wrapped[i]));
          }
          break;
        }
        default: {
          // system and others — LEFT aligned, dim
          const wrapped = wrapText(msg.content || "", maxBubbleWidth);
          for (const line of wrapped) {
            allLines.push("  " + defaultTheme.dim(line));
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
}
