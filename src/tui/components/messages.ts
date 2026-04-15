/**
 * Messages component — scrollable chat message list.
 * Supports streaming append for token-by-token display.
 */
import type { Component } from "../core/component.js";
import type { LayoutConfig } from "../layout/responsive.js";
import { wrapText } from "../utils/wrap.js";
import { visibleWidth, stripAnsi } from "../utils/text-width.js";
import { defaultTheme, ctp } from "../themes/default.js";
import { ICONS } from "../constants/icons.js";
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
  /** Visual tag for special rendering (e.g., tool approval background tint). */
  tag?: "tool-approval";
}

/** Lines above which a message is considered collapsible. */
const COLLAPSE_THRESHOLD = 15;
/** Number of preview lines shown when collapsed. */
const COLLAPSE_PREVIEW = 3;

// ── Agent message tree rendering helpers ─────────────────────────────────────

type MessageSegment =
  | { type: "tool"; line: string }
  | { type: "text"; lines: string[] };

// ── Background tinting helpers ──────────────────────────────────────────────

/** Extract the opening ANSI background escape from a StyleFn. */
function extractBgCode(bgFn: (s: string) => string): string {
  const sample = bgFn("X");
  const idx = sample.indexOf("X");
  return sample.slice(0, idx);
}

/** Apply a background tint to all lines, padding to full width. */
function applyBlockBackground(
  lines: string[],
  bgFn: (s: string) => string,
  width: number,
  leftPad: number = 1,
): string[] {
  const bgCode = extractBgCode(bgFn);
  return lines.map(line => {
    const vis = visibleWidth(line);
    const rightPad = Math.max(0, width - vis - leftPad);
    // Re-inject bg code after any background reset so nested code blocks
    // don't leave gaps in the tint
    const patched = line.replace(/\x1b\[(49|0)m/g, `\x1b[$1m${bgCode}`);
    return `${bgCode}${" ".repeat(leftPad)}${patched}${" ".repeat(rightPad)}\x1b[49m`;
  });
}

/** Render a single ToolCallView as a tree branch line. */
function renderToolInTree(
  view: ToolCallView, lines: string[], branch: string, vert: string, width: number,
): void {
  const rendered = view.render(width);
  for (let r = 0; r < rendered.length; r++) {
    const prefix = r === 0 ? " " + branch + " " : " " + vert + "  ";
    lines.push(prefix + rendered[r]!.trimStart());
  }
}

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

  // Height cache — stores rendered line count per message for virtual scrolling
  private heightCache = new Map<number, { height: number; hash: number; width: number; collapsed: boolean }>();

  // Viewport info set by TUI before render
  private viewportHeight = 0;
  private viewportScrollOffset = 0;

  /** Total line count across all messages (from height cache). */
  private totalLines = 0;

  constructor(id: string) {
    this.id = id;
  }

  /** Called by TUI before render() to inform the component about the visible viewport. */
  setViewport(scrollableHeight: number, scrollOffset: number): void {
    this.viewportHeight = scrollableHeight;
    this.viewportScrollOffset = scrollOffset;
  }

  /** Get total line count (from height cache, without rendering all messages). */
  getTotalLines(): number {
    return this.totalLines;
  }

  render(width: number): string[] {
    const bubblePct = this.layoutProvider?.().messageBubblePercent ?? 0.70;
    const maxBubbleWidth = Math.min(Math.floor(width * bubblePct), width - 8);

    // Width change invalidates all caches
    if (width !== this.lastRenderWidth) {
      this.renderCache.clear();
      this.heightCache.clear();
      this.lastRenderWidth = width;
    }

    const hasLiveTools = this.toolCallOrder.length > 0;
    const msgCount = this.messages.length;

    // ── Pass 1: Build height map + message boundaries ──────────────
    // For each message, get its rendered height from cache or compute it.
    // This is cheap: cache hits return a number, cache misses render + cache.
    this.messageBoundaries = [];
    const heights: number[] = new Array(msgCount);
    let cumulativeHeight = 0;

    for (let i = 0; i < msgCount; i++) {
      const msg = this.messages[i]!;
      const hash = this.contentHash(msg.content);

      // Separator between consecutive system messages
      const hasSeparator = i > 0 && msg.role === "system" && this.messages[i - 1]!.role === "system";
      const separatorHeight = hasSeparator ? 1 : 0;

      this.messageBoundaries.push(cumulativeHeight);

      const isLastMsg = i === msgCount - 1;
      const isAgent = msg.role === "agent" || msg.role === "assistant";
      const isLiveToolMsg = isLastMsg && isAgent && hasLiveTools;
      const isStreaming = isLastMsg && this.renderCache.get(i) === undefined &&
        (msg.role === "agent" || msg.role === "assistant");

      // Always recompute height for live tool messages and streaming messages
      if (isLiveToolMsg || isStreaming) {
        // Will be rendered in pass 2, height unknown until then — use estimate or render now
        const rendered = isLiveToolMsg
          ? this.renderAgentWithLiveTools(msg, width, maxBubbleWidth)
          : this.renderAndCache(i, msg, width, maxBubbleWidth);
        const h = separatorHeight + rendered.length + 1; // +1 for spacing blank line
        heights[i] = h;
        cumulativeHeight += h;
        continue;
      }

      // Check height cache
      const cachedHeight = this.heightCache.get(i);
      if (cachedHeight && cachedHeight.hash === hash && cachedHeight.width === width && cachedHeight.collapsed === !!msg.collapsed) {
        const h = separatorHeight + cachedHeight.height + 1;
        heights[i] = h;
        cumulativeHeight += h;
        continue;
      }

      // Height cache miss — render to get height, store in both caches
      const rendered = this.renderAndCache(i, msg, width, maxBubbleWidth);
      const h = separatorHeight + rendered.length + 1;
      this.heightCache.set(i, { height: rendered.length, hash, width, collapsed: !!msg.collapsed });
      heights[i] = h;
      cumulativeHeight += h;
    }

    this.totalLines = cumulativeHeight;

    // ── Pass 2: Determine visible range and render only those ──────
    const viewH = this.viewportHeight;
    const scrollOff = this.viewportScrollOffset;

    // If no viewport info, fall back to rendering everything (legacy path)
    if (viewH <= 0) {
      return this.renderAll(width, maxBubbleWidth, hasLiveTools);
    }

    // visibleEnd is the line at the bottom of the viewport
    // scrollOffset=0 → bottom, so visibleEnd = totalLines
    const visibleEnd = cumulativeHeight - scrollOff;
    const visibleStart = Math.max(0, visibleEnd - viewH);

    // Find message range that overlaps [visibleStart, visibleEnd)
    // Walk messageBoundaries to find first visible and last visible message
    let firstVisible = msgCount; // start past end
    let lastVisible = -1;
    for (let i = 0; i < msgCount; i++) {
      const msgStart = this.messageBoundaries[i]!;
      const msgEnd = msgStart + heights[i]!;
      if (msgEnd > visibleStart && msgStart < visibleEnd) {
        if (i < firstVisible) firstVisible = i;
        lastVisible = i;
      }
    }

    // Overscan: 1 message buffer above and below
    firstVisible = Math.max(0, firstVisible - 1);
    lastVisible = Math.min(msgCount - 1, lastVisible + 1);

    if (firstVisible > lastVisible) {
      // No visible messages
      return [];
    }

    // ── Pass 3: Render visible messages into output lines ──────────
    // Build the full line array but with empty-line placeholders for off-screen messages
    const allLines: string[] = [];

    // Lines before the visible range → empty placeholders
    const linesBeforeVisible = this.messageBoundaries[firstVisible]!;
    for (let i = 0; i < linesBeforeVisible; i++) {
      allLines.push("");
    }

    // Render visible messages
    for (let i = firstVisible; i <= lastVisible; i++) {
      const msg = this.messages[i]!;

      // Separator between consecutive system messages
      if (i > 0 && msg.role === "system" && this.messages[i - 1]!.role === "system") {
        allLines.push(separator({ width: Math.min(30, maxBubbleWidth - 4), padding: 2 }));
      }

      const isLastMsg = i === msgCount - 1;
      const isAgent = msg.role === "agent" || msg.role === "assistant";
      if (isLastMsg && isAgent && hasLiveTools) {
        const outputLines = this.renderAgentWithLiveTools(msg, width, maxBubbleWidth);
        allLines.push(...outputLines);
        allLines.push("");
        continue;
      }

      // Use render cache (populated in pass 1)
      const hash = this.contentHash(msg.content);
      const cached = this.renderCache.get(i);
      if (cached && cached.hash === hash && cached.width === width && cached.collapsed === !!msg.collapsed) {
        allLines.push(...cached.lines);
        allLines.push("");
        continue;
      }

      // Render and cache
      const rendered = this.renderAndCache(i, msg, width, maxBubbleWidth);
      allLines.push(...rendered);
      allLines.push("");
    }

    // Lines after the visible range → empty placeholders
    const linesAfterVisible = cumulativeHeight - allLines.length;
    for (let i = 0; i < linesAfterVisible; i++) {
      allLines.push("");
    }

    // Evict render cache entries far from viewport to bound memory
    // Keep viewport + 50 message buffer, evict the rest.
    // Height cache is kept (small integers, O(N) is negligible).
    const CACHE_BUFFER = 50;
    const evictBefore = firstVisible - CACHE_BUFFER;
    const evictAfter = lastVisible + CACHE_BUFFER;
    if (this.renderCache.size > evictAfter - evictBefore + 20) {
      for (const key of this.renderCache.keys()) {
        if (key < evictBefore || key > evictAfter) {
          this.renderCache.delete(key);
        }
      }
    }

    return allLines;
  }

  /** Render a message and store in renderCache. Returns the output lines. */
  private renderAndCache(index: number, msg: ChatMessage, width: number, maxBubbleWidth: number): string[] {
    const msgLines = this.renderMessage(msg, width, maxBubbleWidth);
    const outputLines: string[] = [];
    this.pushMaybeCollapsed(outputLines, msgLines, msg, width);
    const hash = this.contentHash(msg.content);
    this.renderCache.set(index, { lines: outputLines, hash, width, collapsed: !!msg.collapsed });
    return outputLines;
  }

  /** Legacy render-all path (when viewport info not available). */
  private renderAll(width: number, maxBubbleWidth: number, hasLiveTools: boolean): string[] {
    const allLines: string[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;
      if (i > 0 && msg.role === "system" && this.messages[i - 1]!.role === "system") {
        allLines.push(separator({ width: Math.min(30, maxBubbleWidth - 4), padding: 2 }));
      }
      this.messageBoundaries[i] = allLines.length;
      const isLastMsg = i === this.messages.length - 1;
      const isAgent = msg.role === "agent" || msg.role === "assistant";
      if (isLastMsg && isAgent && hasLiveTools) {
        allLines.push(...this.renderAgentWithLiveTools(msg, width, maxBubbleWidth));
        allLines.push("");
        continue;
      }
      const cached = this.renderCache.get(i);
      const hash = this.contentHash(msg.content);
      if (cached && cached.hash === hash && cached.width === width && cached.collapsed === !!msg.collapsed) {
        allLines.push(...cached.lines);
        allLines.push("");
        continue;
      }
      const rendered = this.renderAndCache(i, msg, width, maxBubbleWidth);
      allLines.push(...rendered);
      allLines.push("");
    }
    return allLines;
  }

  /** Render a single message to styled lines (before collapse). */
  private renderMessage(msg: ChatMessage, width: number, maxBubbleWidth: number): string[] {
    switch (msg.role) {
      case "user": {
        // Width: full terminal minus bg padding (1 left) and prefix ("> " = 2) and margin (1 right)
        const wrapWidth = Math.max(20, width - 4);
        const wrapped = wrapText(msg.content || "", wrapWidth);
        const accentFn = msg.pending ? ctp.overlay0 : defaultTheme.primary;
        const textFn = msg.pending ? ctp.overlay0 : ctp.text;
        const rawLines = wrapped.map((line, i) => {
          const prefix = i === 0 ? accentFn("> ") : "  ";
          return prefix + textFn(line);
        });
        return applyBlockBackground(rawLines, defaultTheme.agentResponseBg, width);
      }
      case "assistant":
      case "agent": {
        const nameLabel = msg.agentName ?? "OpenPawl";
        const badgeLines: string[] = [];

        const contentLines: string[] = [];
        const segments = parseMessageSegments((msg.content || "").replace(/^\n+/, ""));
        const hasTools = segments.some(s => s.type === "tool");
        const contentWidth = width - 2; // 1 left pad + 1 right margin inside bg block

        // Badge with optional tool count for baked messages with collapsed tools
        const toolSegCount = segments.filter(s => s.type === "tool").length;
        // Check for "... N more tools completed" line to compute actual total
        const collapsedMatch = (msg.content || "").match(/\.\.\.\s+(\d+)\s+more tools completed/);
        const totalToolCount = collapsedMatch
          ? toolSegCount + parseInt(collapsedMatch[1]!, 10)
          : toolSegCount;
        if (totalToolCount > 3) {
          badgeLines.push("  " + agentBadge(nameLabel) + ctp.overlay0(` (used ${totalToolCount} tools)`));
        } else {
          badgeLines.push("  " + agentBadge(nameLabel));
        }

        if (!hasTools) {
          for (const seg of segments) {
            if (seg.type === "text") {
              const md = renderMarkdown(seg.lines.join("\n"), contentWidth - 4);
              for (const ml of md) contentLines.push("   " + ml);
            }
          }
        } else {
          // Tree rendering: tool lines with connectors, text blocks indented
          const BRANCH = ctp.overlay0("├─");
          const LAST   = ctp.overlay0("└─");
          const VERT   = ctp.overlay0("│");

          // Count tool segments for collapse logic
          const toolSegs: Array<{ type: "tool"; line: string }> = [];
          const textSegs: Array<{ seg: { type: "text"; lines: string[] }; index: number }> = [];
          for (let si = 0; si < segments.length; si++) {
            const s = segments[si]!;
            if (s.type === "tool") toolSegs.push(s);
            else textSegs.push({ seg: s, index: si });
          }

          const COLLAPSE_THRESHOLD = 3;
          const shouldCollapse = toolSegs.length > COLLAPSE_THRESHOLD;

          // Render tool lines (collapsed or full)
          if (shouldCollapse) {
            const showFirst = 2;
            // First 2 tools
            for (let t = 0; t < Math.min(showFirst, toolSegs.length); t++) {
              contentLines.push(" " + BRANCH + " " + toolSegs[t]!.line);
            }
            // Collapsed summary
            const hiddenCount = toolSegs.length - showFirst - (toolSegs.length > showFirst ? 1 : 0);
            if (hiddenCount > 0) {
              contentLines.push(" " + BRANCH + "  " + ctp.overlay0(`... ${hiddenCount} more tools completed`));
            }
            // Last tool
            if (toolSegs.length > showFirst) {
              contentLines.push(" " + BRANCH + " " + toolSegs[toolSegs.length - 1]!.line);
            }
          } else {
            for (let si = 0; si < segments.length; si++) {
              const seg = segments[si]!;
              if (seg.type !== "tool") continue;
              const isLastTool = !segments.slice(si + 1).some(s => s.type === "tool");
              const isFinalSeg = si === segments.length - 1;
              const connector = (isLastTool && isFinalSeg) ? LAST : BRANCH;
              contentLines.push(" " + connector + " " + seg.line);
            }
          }

          // Render text segments
          for (const { seg, index: si } of textSegs) {
            const trimmed = seg.lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
            if (!trimmed) continue;

            const isFinal = si === segments.length - 1;
            if (isFinal) {
              contentLines.push(" " + VERT);
              const md = renderMarkdown(trimmed, contentWidth - 4);
              for (const ml of md) contentLines.push("   " + ml);
            } else {
              contentLines.push(" " + VERT);
              const md = renderMarkdown(trimmed, contentWidth - 5);
              for (const ml of md) contentLines.push(" " + VERT + " " + ml);
              contentLines.push(" " + VERT);
            }
          }
        }

        return [...badgeLines, ...contentLines];
      }
      case "error": {
        const wrapped = wrapText(msg.content || "", maxBubbleWidth - 4);
        return wrapped.map((line, i) => {
          const prefix = i === 0 ? `${ICONS.error} ` : "  ";
          return "  " + defaultTheme.error(prefix + line);
        });
      }
      case "tool": {
        const wrapped = wrapText(msg.content || "", maxBubbleWidth - 4);
        return wrapped.map((line, i) => {
          const prefix = i === 0 ? ctp.teal(`${ICONS.gear} `) : "  ";
          return "  " + prefix + ctp.overlay1(line);
        });
      }
      case "system": {
        const content = msg.content || "";
        let sysLines: string[];
        if (content.includes("\x1b[")) {
          // Already styled (e.g., panel output, welcome screen) — pass through as-is
          sysLines = content.split("\n").map((line) => "  " + line);
        } else {
          const colorFn = detectSystemColor(content);
          const mdLines = renderMarkdown(content, maxBubbleWidth - 2);
          sysLines = mdLines.map((line) => "  " + colorFn(line));
        }
        // Tool approval prompts get a subtle warm background tint
        if (msg.tag === "tool-approval") {
          return applyBlockBackground(sysLines, defaultTheme.toolApprovalBg, width);
        }
        return sysLines;
      }
      default: {
        const hasAnsi = (msg.content || "").includes("\x1b[");
        const colorFn = hasAnsi ? (s: string) => s : ctp.overlay1;
        const wrapped = wrapText(msg.content || "", maxBubbleWidth);
        return wrapped.map((line) => "  " + colorFn(line));
      }
    }
  }

  /** Render the last agent message with live tool call views embedded in tree structure. */
  private renderAgentWithLiveTools(msg: ChatMessage, width: number, maxBubbleWidth: number): string[] {
    const nameLabel = msg.agentName ?? "OpenPawl";
    const badgeLines: string[] = [];
    const BRANCH = ctp.overlay0("├─");
    const VERT   = ctp.overlay0("│");

    // Badge (root of tree) — outside background block
    badgeLines.push("  " + agentBadge(nameLabel));

    const contentLines: string[] = [];

    // Partition tool calls into completed and running
    const completed: ToolCallView[] = [];
    const running: ToolCallView[] = [];
    for (const tid of this.toolCallOrder) {
      const view = this.activeToolCalls.get(tid);
      if (!view) continue;
      if (view.status === "completed" || view.status === "failed") {
        completed.push(view);
      } else {
        running.push(view);
      }
    }

    const totalTools = completed.length + running.length;
    const COLLAPSE_THRESHOLD = 3;

    if (totalTools <= COLLAPSE_THRESHOLD) {
      // Render all normally
      for (const tid of this.toolCallOrder) {
        const view = this.activeToolCalls.get(tid);
        if (view) renderToolInTree(view, contentLines, BRANCH, VERT, maxBubbleWidth);
      }
    } else {
      // Collapsed rendering: first 2, summary, last completed, then running
      const showFirst = 2;

      for (let i = 0; i < Math.min(showFirst, completed.length); i++) {
        renderToolInTree(completed[i]!, contentLines, BRANCH, VERT, maxBubbleWidth);
      }

      const hiddenCount = completed.length - showFirst - (completed.length > showFirst ? 1 : 0);
      if (hiddenCount > 0) {
        contentLines.push(" " + BRANCH + "  " + ctp.overlay0(`... ${hiddenCount} more tools completed`));
      }

      if (completed.length > showFirst) {
        renderToolInTree(completed[completed.length - 1]!, contentLines, BRANCH, VERT, maxBubbleWidth);
      }

      for (const view of running) {
        renderToolInTree(view, contentLines, BRANCH, VERT, maxBubbleWidth);
      }
    }

    // Content (thinking text or streaming response) — inside tree
    const content = (msg.content || "").replace(/^\n+/, "");
    if (content) {
      contentLines.push(" " + VERT);
      const md = renderMarkdown(content, maxBubbleWidth - 4);
      for (const ml of md) contentLines.push("   " + ml);
    } else if (running.length === 0 && totalTools > 0) {
      // Agent is thinking (no content yet, no tools running, but had tools)
      contentLines.push(" " + VERT);
      contentLines.push("   " + ctp.overlay0("thinking..."));
    }

    return [...badgeLines, ...contentLines];
  }

  /** Fast content hash for cache invalidation (FNV-1a). */
  private contentHash(content: string): number {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = (hash * 0x01000193) | 0; // FNV prime, keep as 32-bit int
    }
    return hash;
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
      allLines.push("  " + ctp.overlay0(`  ${ICONS.cursor} ${hidden} more lines — Ctrl+E to expand`));
    } else {
      allLines.push(...msgLines);
    }
  }

  /** Remove the last message matching a given tag. Returns true if found. */
  removeLastByTag(tag: string): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.tag === tag) {
        this.messages.splice(i, 1);
        this.renderCache.clear();
        this.heightCache.clear();
        return true;
      }
    }
    return false;
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
        this.renderCache.delete(i);
        this.heightCache.delete(i);
      }
    }
    this.messages.push(msg);
  }

  /** Replace the last message's content entirely (for thinking indicator). */
  replaceLast(content: string): void {
    if (this.messages.length > 0) {
      const idx = this.messages.length - 1;
      this.messages[idx]!.content = content;
      this.renderCache.delete(idx);
      this.heightCache.delete(idx);
    }
  }

  /** Replace the last message entirely (e.g., swap thinking for agent message). */
  replaceLastWith(msg: ChatMessage): void {
    if (this.messages.length > 0) {
      const idx = this.messages.length - 1;
      this.messages[idx] = msg;
      this.renderCache.delete(idx);
      this.heightCache.delete(idx);
    } else {
      this.messages.push(msg);
    }
  }

  /** Check if the last message is an agent/assistant message. */
  isLastAgentMessage(): boolean {
    if (this.messages.length === 0) return false;
    const last = this.messages[this.messages.length - 1]!;
    return last.role === "agent" || last.role === "assistant";
  }

  /** Append text to the last message (streaming). */
  appendToLast(chunk: string): void {
    if (this.messages.length === 0) {
      this.messages.push({ role: "assistant", content: chunk });
    } else {
      const idx = this.messages.length - 1;
      this.messages[idx]!.content += chunk;
      this.renderCache.delete(idx);
      this.heightCache.delete(idx);
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
  completeToolCall(executionId: string, success: boolean, outputSummary: string, duration: number, diff?: import("../../utils/diff.js").DiffResult): void {
    const view = this.activeToolCalls.get(executionId);
    if (!view) return;
    view.complete({ success, summary: outputSummary, duration, diff });
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
      // Build compact baked content (collapse if > 3 tools)
      let toolSummary: string;
      if (summaryLines.length > 3) {
        const showFirst = 2;
        const hiddenCount = summaryLines.length - showFirst - 1;
        const parts = [
          ...summaryLines.slice(0, showFirst),
          ctp.overlay0(`... ${hiddenCount} more tools completed`),
          summaryLines[summaryLines.length - 1]!,
        ];
        toolSummary = parts.join("\n");
      } else {
        toolSummary = summaryLines.join("\n");
      }

      // Find the last agent/assistant message and prepend tool info
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const msg = this.messages[i]!;
        if (msg.role === "agent" || msg.role === "assistant") {
          msg.content = toolSummary + "\n\n" + (msg.content || "");
          this.renderCache.delete(i);
          this.heightCache.delete(i);
          break;
        }
      }
    }

    this.clearToolCalls();
  }

  /** Toggle expand/collapse on all active tool calls. */
  toggleAllToolCalls(): boolean {
    if (this.activeToolCalls.size === 0) return false;
    const anyCollapsed = [...this.activeToolCalls.values()].some(v => !v.isExpanded);
    for (const view of this.activeToolCalls.values()) {
      view.setExpanded(anyCollapsed);
    }
    this.renderCache.clear();
    this.heightCache.clear();
    return true;
  }

  /** Remove all pending (queued) messages. */
  removePendingMessages(): void {
    this.messages = this.messages.filter(m => !m.pending);
    this.renderCache.clear();
    this.heightCache.clear();
  }

  /** Mark the first pending message as active (no longer dimmed). */
  markNextPendingAsActive(): void {
    const idx = this.messages.findIndex(m => m.pending);
    if (idx !== -1) {
      this.messages[idx]!.pending = false;
      this.renderCache.delete(idx);
      this.heightCache.delete(idx);
    }
  }

  clear(): void {
    this.messages = [];
    this.renderCache.clear();
    this.heightCache.clear();
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
    this.heightCache.delete(index);
    return true;
  }

  /** Collapse all collapsible messages. */
  collapseAll(): void {
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]!.collapsible) {
        this.messages[i]!.collapsed = true;
        this.renderCache.delete(i);
        this.heightCache.delete(i);
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

  /** Count messages whose start boundary falls within a visible line range. */
  getVisibleMessageCount(visibleStart: number, visibleEnd: number): number {
    let count = 0;
    for (const boundary of this.messageBoundaries) {
      if (boundary >= visibleStart && boundary < visibleEnd) count++;
    }
    return count;
  }
}

/** Detect system message subtype and return the appropriate color function. */
function detectSystemColor(content: string): (s: string) => string {
  const first = content.slice(0, 60);
  // Error-like messages — check first (most specific patterns)
  if (/^(Error:|Failed |Cannot |Could not )/i.test(first)) {
    return ctp.red;
  }
  // Negative results — require colon/period after "No"/"Not" to avoid false positives
  if (/^(No\b.+\bfound|Not\b.+\bavailable|No results)/i.test(first)) {
    return ctp.red;
  }
  // Success / status messages
  if (first.startsWith("**") || /\bactive\b|\bmode\b|\bcaptured\b|\bswitching\b/i.test(first)) {
    return ctp.green;
  }
  // Help / usage messages
  if (first.startsWith("Usage:") || first.startsWith("Example:") || content.includes("Use `/")) {
    return ctp.overlay1;
  }
  return ctp.overlay2;
}
