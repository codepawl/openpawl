/**
 * Messages component — scrollable chat message list.
 * Supports streaming append for token-by-token display.
 */
import type { Component } from "../core/component.js";
import type { LayoutConfig } from "../layout/responsive.js";
import { wrapText } from "../utils/wrap.js";
import { visibleWidth, stripAnsi } from "../utils/text-width.js";
import { defaultTheme, ctp } from "../themes/default.js";
import { renderMarkdown } from "./markdown.js";
import { CopyManager } from "../text/copy-manager.js";
import { ToolCallView } from "./tool-call-view.js";
import { separator } from "../primitives/separator.js";
import { agentBadge } from "../primitives/badge.js";

export interface ChatMessage {
  role: "user" | "assistant" | "agent" | "tool" | "system" | "error";
  content: string;
  agentName?: string;
  agentColor?: (s: string) => string;
  timestamp?: Date;
  collapsible?: boolean;
  collapsed?: boolean;
  /** Queued message not yet processed — rendered dimmed. */
  pending?: boolean;
}

/** Lines above which a message is considered collapsible. */
const COLLAPSE_THRESHOLD = 15;
/** Number of preview lines shown when collapsed. */
const COLLAPSE_PREVIEW = 3;

// ── Agent message tree rendering helpers ─────────────────────────────────────

type MessageSegment =
  | { type: "tool"; line: string }
  | { type: "text"; lines: string[] };

/** Check if a line is a baked tool summary (starts with ✓, ✗, ⏳, or ○). */
function isToolLine(line: string): boolean {
  const stripped = stripAnsi(line).trimStart();
  return /^[✓✗⏳○⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(stripped);
}

/** Split baked agent message content into tool lines and text blocks. */
function parseMessageSegments(content: string): MessageSegment[] {
  const lines = content.split("\n");
  const segments: MessageSegment[] = [];
  let textBuf: string[] = [];

  for (const line of lines) {
    if (isToolLine(line)) {
      if (textBuf.length > 0) {
        segments.push({ type: "text", lines: textBuf });
        textBuf = [];
      }
      segments.push({ type: "tool", line });
    } else {
      textBuf.push(line);
    }
  }
  if (textBuf.length > 0) {
    segments.push({ type: "text", lines: textBuf });
  }
  return segments;
}

export class MessagesComponent implements Component {
  readonly id: string;
  readonly focusable = true;
  hidden = false;

  private messages: ChatMessage[] = [];
  /** Line index where each message starts (into the rendered allLines array). */
  private messageBoundaries: number[] = [];
  private layoutProvider?: () => LayoutConfig;

  /** Active tool call views, keyed by executionId. */
  private activeToolCalls = new Map<string, ToolCallView>();
  /** Insertion order for tool call rendering. */
  private toolCallOrder: string[] = [];

  // Render cache — avoids re-running renderMarkdown/wrapText on every frame
  private renderCache = new Map<number, { lines: string[]; hash: number; width: number; collapsed: boolean }>();
  private lastRenderWidth = 0;

  constructor(id: string) {
    this.id = id;
  }

  render(width: number): string[] {
    const allLines: string[] = [];
    const bubblePct = this.layoutProvider?.().messageBubblePercent ?? 0.70;
    const maxBubbleWidth = Math.min(Math.floor(width * bubblePct), width - 8);
    this.messageBoundaries = [];

    // Width change invalidates all caches
    if (width !== this.lastRenderWidth) {
      this.renderCache.clear();
      this.lastRenderWidth = width;
    }

    // Determine where to insert live tool call views:
    // Before the last message (the streaming response), not after all messages.
    const hasLiveTools = this.toolCallOrder.length > 0;
    const toolInsertBefore = hasLiveTools ? this.messages.length - 1 : -1;

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;

      // Dimmed divider between consecutive system messages
      if (i > 0 && msg.role === "system" && this.messages[i - 1]!.role === "system") {
        allLines.push(separator({ width: Math.min(30, maxBubbleWidth - 4), padding: 2 }));
      }

      // Insert live tool call views before the last (streaming) message — with tree connectors
      if (i === toolInsertBefore) {
        const toolIds = [...this.toolCallOrder];
        const connector = ctp.overlay0("├─");
        const vertLine = ctp.overlay0("│");
        for (const tid of toolIds) {
          const view = this.activeToolCalls.get(tid);
          if (view) {
            const rendered = view.render(bubblePct > 0 ? maxBubbleWidth : width);
            for (let r = 0; r < rendered.length; r++) {
              const prefix = r === 0 ? "  " + connector + " " : "  " + vertLine + "  ";
              allLines.push(prefix + rendered[r]!.trimStart());
            }
          }
        }
        allLines.push("  " + vertLine);
      }

      this.messageBoundaries.push(allLines.length);

      // Check render cache
      const hash = this.contentHash(msg.content);
      const cached = this.renderCache.get(i);
      if (cached && cached.hash === hash && cached.width === width && cached.collapsed === !!msg.collapsed) {
        allLines.push(...cached.lines);
        allLines.push("");
        continue;
      }

      // Cache miss — render and store
      const msgLines = this.renderMessage(msg, width, maxBubbleWidth);
      const outputLines: string[] = [];
      this.pushMaybeCollapsed(outputLines, msgLines, msg, width);
      this.renderCache.set(i, { lines: outputLines, hash, width, collapsed: !!msg.collapsed });
      allLines.push(...outputLines);
      allLines.push(""); // spacing
    }

    return allLines;
  }

  /** Render a single message to styled lines (before collapse). */
  private renderMessage(msg: ChatMessage, width: number, maxBubbleWidth: number): string[] {
    switch (msg.role) {
      case "user": {
        const userMaxWidth = Math.min(Math.floor(width * 0.5), maxBubbleWidth);
        const wrapped = wrapText(msg.content || "", userMaxWidth - 4);
        const contentWidth = wrapped.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
        const boxWidth = contentWidth + 4;
        const leftPad = " ".repeat(Math.max(0, width - boxWidth));
        const dim = msg.pending ? ctp.overlay0 : ctp.surface1;
        const textFn = msg.pending ? ctp.overlay0 : ctp.text;
        const lines: string[] = [];
        if (msg.pending) {
          lines.push(leftPad + dim("⏳ ") + dim("┌" + "─".repeat(Math.max(0, boxWidth - 4)) + "┐"));
        } else {
          lines.push(leftPad + dim("┌" + "─".repeat(boxWidth - 2) + "┐"));
        }
        for (const line of wrapped) {
          const padRight = contentWidth - visibleWidth(line);
          lines.push(leftPad + dim("│") + " " + textFn(line) + " ".repeat(padRight) + " " + dim("│"));
        }
        lines.push(leftPad + dim("└" + "─".repeat(boxWidth - 2) + "┘"));
        return lines;
      }
      case "assistant":
      case "agent": {
        const nameLabel = msg.agentName ?? (msg.role.charAt(0).toUpperCase() + msg.role.slice(1));
        const lines: string[] = [];
        lines.push("  " + agentBadge(nameLabel));

        const segments = parseMessageSegments((msg.content || "").replace(/^\n+/, ""));
        const hasTools = segments.some(s => s.type === "tool");

        if (!hasTools) {
          // No tools — badge + blank + indented response
          lines.push("");
          for (const seg of segments) {
            if (seg.type === "text") {
              const md = renderMarkdown(seg.lines.join("\n"), maxBubbleWidth - 4);
              for (const ml of md) lines.push("    " + ml);
            }
          }
          return lines;
        }

        // Tree rendering: tool lines with connectors, text blocks indented
        const BRANCH = ctp.overlay0("├─");
        const LAST   = ctp.overlay0("└─");
        const VERT   = ctp.overlay0("│");

        for (let si = 0; si < segments.length; si++) {
          const seg = segments[si]!;

          if (seg.type === "tool") {
            const isLastTool = !segments.slice(si + 1).some(s => s.type === "tool");
            const isFinalSeg = si === segments.length - 1;
            const connector = (isLastTool && isFinalSeg) ? LAST : BRANCH;
            lines.push("  " + connector + " " + seg.line);
            continue;
          }

          // Text segment
          const trimmed = seg.lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
          if (!trimmed) continue;

          const isFinal = si === segments.length - 1;
          if (isFinal) {
            // Final response: vert line separator, then indented text
            lines.push("  " + VERT);
            const md = renderMarkdown(trimmed, maxBubbleWidth - 4);
            for (const ml of md) lines.push("    " + ml);
          } else {
            // Intermediate text: continuation lines with vert prefix
            lines.push("  " + VERT);
            const md = renderMarkdown(trimmed, maxBubbleWidth - 6);
            for (const ml of md) lines.push("  " + VERT + " " + ml);
            lines.push("  " + VERT);
          }
        }

        return lines;
      }
      case "error": {
        const wrapped = wrapText(msg.content || "", maxBubbleWidth - 4);
        return wrapped.map((line, i) => {
          const prefix = i === 0 ? "✗ " : "  ";
          return "  " + defaultTheme.error(prefix + line);
        });
      }
      case "tool": {
        const wrapped = wrapText(msg.content || "", maxBubbleWidth - 4);
        return wrapped.map((line, i) => {
          const prefix = i === 0 ? ctp.teal("⚙ ") : "  ";
          return "  " + prefix + ctp.overlay1(line);
        });
      }
      case "system": {
        const content = msg.content || "";
        if (content.includes("\x1b[")) {
          // Already styled (e.g., panel output, welcome screen) — pass through as-is
          return content.split("\n").map((line) => "  " + line);
        }
        const colorFn = detectSystemColor(content);
        const mdLines = renderMarkdown(content, maxBubbleWidth - 2);
        return mdLines.map((line) => "  " + colorFn(line));
      }
      default: {
        const hasAnsi = (msg.content || "").includes("\x1b[");
        const colorFn = hasAnsi ? (s: string) => s : ctp.overlay1;
        const wrapped = wrapText(msg.content || "", maxBubbleWidth);
        return wrapped.map((line) => "  " + colorFn(line));
      }
    }
  }

  /** Fast content hash for cache invalidation. */
  private contentHash(content: string): number {
    const len = content.length;
    if (len === 0) return 0;
    return len * 31 + content.charCodeAt(0) + content.charCodeAt(len - 1) + content.charCodeAt(len >> 1);
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
      allLines.push("  " + ctp.overlay0(`  ▸ ${hidden} more lines — Ctrl+E to expand`));
    } else {
      allLines.push(...msgLines);
    }
  }

  addMessage(msg: ChatMessage): void {
    // Auto-collapse previous long tool messages (not assistant/agent text)
    for (let i = 0; i < this.messages.length; i++) {
      const prev = this.messages[i]!;
      if (
        prev.role === "tool" &&
        prev.collapsible &&
        prev.collapsed === undefined
      ) {
        prev.collapsed = true;
        this.renderCache.delete(i); // collapse state changed
      }
    }
    this.messages.push(msg);
  }

  /** Replace the last message's content entirely (for thinking indicator). */
  replaceLast(content: string): void {
    if (this.messages.length > 0) {
      this.messages[this.messages.length - 1]!.content = content;
      this.renderCache.delete(this.messages.length - 1);
    }
  }

  /** Replace the last message entirely (e.g., swap thinking for agent message). */
  replaceLastWith(msg: ChatMessage): void {
    if (this.messages.length > 0) {
      this.messages[this.messages.length - 1] = msg;
      this.renderCache.delete(this.messages.length - 1);
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
      this.renderCache.delete(this.messages.length - 1);
    }
  }

  /** Start tracking a new tool call with a spinner. */
  startToolCall(executionId: string, toolName: string, inputSummary: string, agentId: string): void {
    if (this.activeToolCalls.has(executionId)) return;
    const view = new ToolCallView({
      executionId,
      toolName,
      agentId,
      status: "running",
      inputSummary,
    });
    this.activeToolCalls.set(executionId, view);
    this.toolCallOrder.push(executionId);
  }

  /** Mark a tool call as completed or failed. */
  completeToolCall(executionId: string, success: boolean, outputSummary: string, duration: number): void {
    const view = this.activeToolCalls.get(executionId);
    if (!view) return;
    view.complete({ success, summary: outputSummary, duration });
  }

  /** Advance all running tool call spinners (call from timer). */
  advanceToolSpinners(): void {
    for (const view of this.activeToolCalls.values()) {
      if (view.status === "running") {
        view.advanceSpinner();
      }
    }
  }

  /** Check if any tool calls are currently running. */
  hasRunningToolCalls(): boolean {
    for (const view of this.activeToolCalls.values()) {
      if (view.status === "running") return true;
    }
    return false;
  }

  /** Clear all tool call views (call on agent:done). */
  clearToolCalls(): void {
    this.activeToolCalls.clear();
    this.toolCallOrder = [];
  }

  /**
   * Bake completed tool call summaries into the last agent message,
   * then clear the live tool views. This makes tool status scroll with
   * the conversation instead of sticking above the input.
   */
  bakeToolCalls(): void {
    if (this.toolCallOrder.length === 0) return;

    // Build a compact summary of all tool calls
    const summaryLines: string[] = [];
    for (const id of this.toolCallOrder) {
      const view = this.activeToolCalls.get(id);
      if (view) {
        summaryLines.push(view.renderOneLiner());
      }
    }

    if (summaryLines.length > 0) {
      // Insert as a system message before the last agent message
      const toolSummary = summaryLines.join("\n");
      // Find the last agent/assistant message and prepend tool info
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const msg = this.messages[i]!;
        if (msg.role === "agent" || msg.role === "assistant") {
          msg.content = toolSummary + "\n\n" + (msg.content || "");
          this.renderCache.delete(i);
          break;
        }
      }
    }

    this.clearToolCalls();
  }

  /** Remove all pending (queued) messages. */
  removePendingMessages(): void {
    this.messages = this.messages.filter(m => !m.pending);
    this.renderCache.clear();
  }

  /** Mark the first pending message as active (no longer dimmed). */
  markNextPendingAsActive(): void {
    const idx = this.messages.findIndex(m => m.pending);
    if (idx !== -1) {
      this.messages[idx]!.pending = false;
      this.renderCache.delete(idx);
    }
  }

  clear(): void {
    this.messages = [];
    this.renderCache.clear();
    this.activeToolCalls.clear();
    this.toolCallOrder = [];
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
    this.renderCache.delete(index);
    return true;
  }

  /** Collapse all collapsible messages. */
  collapseAll(): void {
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]!.collapsible) {
        this.messages[i]!.collapsed = true;
        this.renderCache.delete(i);
      }
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

/** Detect system message subtype and return the appropriate color function. */
function detectSystemColor(content: string): (s: string) => string {
  const first = content.slice(0, 40);
  // Success / status messages
  if (first.startsWith("**") || /\bactive\b|\bmode\b|\bcaptured\b|\bswitching\b/i.test(first)) {
    return ctp.green;
  }
  // Help / usage messages
  if (first.startsWith("Usage:") || first.startsWith("Example:") || content.includes("Use `/")) {
    return ctp.overlay1;
  }
  // Error-like messages
  if (/^(Error|No |Not |Cannot |Failed)/i.test(first)) {
    return ctp.red;
  }
  return ctp.overlay2;
}
