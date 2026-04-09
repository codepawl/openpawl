/**
 * Root TUI controller — manages the component tree, render loop,
 * focus management, and input routing.
 *
 * Supports two layout modes:
 * 1. Legacy: all children in a Container, truncated to terminal height
 * 2. Split-region: one scrollable component + fixed-bottom components
 *    The scrollable region fills remaining rows; fixed components stay at bottom.
 */
import { Container, type Component } from "./component.js";
import { DiffRenderer } from "./renderer.js";
import { InputParser, type KeyEvent } from "./input.js";
import { ProcessTerminal, type Terminal } from "./terminal.js";
import { hideCursor, showCursor, cursorTo } from "./ansi.js";
import { SelectionManager } from "./selection.js";
import { KeybindingManager, type KeyContext } from "../keyboard/keybindings.js";
import { DEV } from "../../dev/index.js";
import type { ActionId } from "../keyboard/actions.js";
import type { PresetName } from "../keyboard/keymap-presets.js";
import { CopyManager, cleanCopyText } from "../text/copy-manager.js";
import { computeLayout, DEFAULT_LAYOUT, type LayoutConfig } from "../layout/responsive.js";

export class TUI {
  readonly keybindings: KeybindingManager;
  private terminal: Terminal;
  private renderer: DiffRenderer;
  private root: Container;
  private layout: LayoutConfig = DEFAULT_LAYOUT;
  private inputParser: InputParser;
  private focusedComponent: Component | null = null;
  private overlayComponent: Component | null = null;
  private renderPending = false;
  private running = false;

  // Resize debounce
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // Split-region layout
  private scrollableComponent: Component | null = null;
  private fixedBottomComponents: Component[] = [];
  private scrollOffset = 0; // 0 = at bottom, positive = scrolled up
  private autoScroll = true;

  // Text selection + copy
  private selectionManager = new SelectionManager();
  private copyManager = new CopyManager();
  private lastScreenLines: string[] = [];
  private lastFullContentLines: string[] = [];  // all content lines (not just visible)
  private contentRowEnd = 0;   // last row of messages content region (1-based)
  private editorRowStart = 0;  // first row of editor region (1-based)
  private editorRowEnd = 0;    // last row of editor region (1-based)
  private statusBarRow = 0;    // status bar row (1-based)

  // Mouse state
  private lastClickTime = 0;
  private lastClickRow = 0;
  private lastClickCol = 0;
  private clickCount = 0;
  private mouseDownPos: { row: number; col: number } | null = null;
  private isDragging = false;
  private autoScrollTimer: ReturnType<typeof setInterval> | null = null;

  // Key handler stack — interactive views push handlers that take priority
  private keyHandlerStack: { handleKey: (event: KeyEvent) => boolean }[] = [];

  // Interactive view content (renders at bottom of scrollable area)
  private interactiveLines: string[] | null = null;
  private interactiveStartRow = 0; // screen row where interactive content starts (1-based)

  /** Called when the TUI exits (Ctrl+C or Ctrl+D). */
  onExit?: () => void;
  /** Called when Ctrl+C should abort a running task. Return true if handled. */
  onAbort?: () => boolean;
  /** Called to display a system message (e.g., "Press Ctrl+C again to exit"). */
  onSystemMessage?: (msg: string) => void;
  /** Called to show a brief flash notification (e.g., "Copied!"). */
  onFlashMessage?: (msg: string) => void;
  /** Called when a mode action is triggered (e.g., "cycle", "auto", "build"). */
  onModeAction?: (action: string) => void;
  /** Called to jump scroll to a prompt boundary. Returns the total content lines at that prompt. */
  onScrollToPrompt?: (direction: "prev" | "next") => number | null;
  /** Called to toggle collapse on the message currently in view. */
  onToggleCollapse?: () => boolean;
  /** Called when scroll position changes. */
  onScrollPositionChanged?: (scrollOffset: number, totalLines: number) => void;

  constructor(terminal?: Terminal, preset?: PresetName) {
    this.keybindings = new KeybindingManager(preset ?? detectPlatform());
    this.terminal = terminal ?? new ProcessTerminal();
    this.renderer = new DiffRenderer();
    this.root = new Container("__root__");
    this.inputParser = new InputParser();
    this.inputParser.onEvent = this.handleEvent.bind(this);
  }

  /** Get the current responsive layout config (recomputed each render frame). */
  getLayout(): LayoutConfig {
    return this.layout;
  }

  // ── Lifecycle ───────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    DEV.init();
    this.terminal.start();
    this.copyManager.setTerminal(this.terminal);

    this.terminal.onInput((data: Buffer) => {
      try {
        if (DEV.enabled) DEV.logInput(data.toString("hex"), "raw");
        this.inputParser.feed(data);
      } catch (err) {
        this.handleUncaughtError(err);
      }
    });

    this.terminal.onResize(() => this.handleResize());

    this.requestRender();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    DEV.destroy();
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = null; }
    this.terminal.write(showCursor);
    this.terminal.stop();
  }

  // ── Resize ──────────────────────────────────────────────

  /** Debounced resize — batches rapid SIGWINCH events into one re-render. */
  private handleResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (!this.running) return;
      this.performResize();
    }, 100);
  }

  private performResize(): void {
    // Hide cursor during resize to prevent flicker
    this.terminal.write(hideCursor);
    // Move cursor home — the full redraw will overwrite every line
    this.terminal.write("\x1b[H");
    // Invalidate renderer cache so next render is a full redraw
    this.renderer.reset();
    // Full re-render at new dimensions
    this.requestRender();
  }

  // ── Split-region API ────────────────────────────────────

  /** Set the scrollable content component (fills remaining rows above fixed bottom). */
  setScrollableContent(component: Component): void {
    this.scrollableComponent = component;
  }

  /** Add a component fixed at the bottom (order matters: first added = topmost). */
  addFixedBottom(component: Component): void {
    this.fixedBottomComponents.push(component);
    component.onMount?.();
  }

  /** Hide or show a fixed-bottom component by ID. */
  setFixedBottomHidden(id: string, hidden: boolean): void {
    for (const comp of this.fixedBottomComponents) {
      if (comp.id === id) {
        comp.hidden = hidden;
        break;
      }
    }
  }

  /** Hide or show the scrollable content (messages area). */
  setScrollableHidden(hidden: boolean): void {
    if (this.scrollableComponent) {
      this.scrollableComponent.hidden = hidden;
    }
  }

  /** Scroll the messages area up (shows older content). */
  scrollUp(lines = 3): void {
    this.scrollOffset += lines;
    this.autoScroll = false;
    this.updateBreadcrumb();
    this.requestRender();
  }

  /** Scroll the messages area down (shows newer content). */
  scrollDown(lines = 3): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    if (this.scrollOffset === 0) this.autoScroll = true;
    this.updateBreadcrumb();
    this.requestRender();
  }

  /** Scroll to the bottom (latest messages). */
  scrollToBottom(): void {
    this.scrollOffset = 0;
    this.autoScroll = true;
    this.updateBreadcrumb();
    this.requestRender();
  }

  /** Update the divider breadcrumb label based on current scroll position. */
  private updateBreadcrumb(): void {
    // Delegate to the app layer which knows about the divider and messages
    this.onScrollPositionChanged?.(this.scrollOffset, this.lastFullContentLines.length);
  }

  /** Notify that new content was added — auto-scrolls if at bottom. */
  onNewContent(): void {
    if (this.autoScroll) {
      this.scrollOffset = 0;
    }
  }

  // ── Interactive views ────────────────────────────────────

  /** Push a key handler that takes priority over normal input routing. */
  pushKeyHandler(handler: { handleKey: (event: KeyEvent) => boolean }): void {
    this.keyHandlerStack.push(handler);
    this.updateEditorSuppressHistory();
  }

  /** Remove the most recent key handler. */
  popKeyHandler(): void {
    this.keyHandlerStack.pop();
    this.updateEditorSuppressHistory();
  }

  /** Suppress editor history when an interactive view is active. */
  private updateEditorSuppressHistory(): void {
    const editor = this.focusedComponent as Component & { suppressHistory?: boolean };
    if (editor && "suppressHistory" in editor) {
      editor.suppressHistory = this.keyHandlerStack.length > 0;
    }
  }

  /** Set interactive view content (renders at bottom of scrollable area). */
  setInteractiveView(lines: string[]): void {
    this.interactiveLines = lines;
    this.scrollOffset = 0;
    this.autoScroll = true;
    this.requestRender();
  }

  /** Clear interactive view, restore normal messages. */
  clearInteractiveView(): void {
    this.interactiveLines = null;
    // Full repaint — the diff renderer's cache has the interactive view's
    // lines, which would cause stale regions if only diffed.
    this.renderer.reset();
    this.requestRender();
  }

  /** Check if an interactive view is active. */
  hasInteractiveView(): boolean {
    return this.interactiveLines !== null;
  }

  /** Get the screen row where the interactive content starts (1-based). */
  getInteractiveStartRow(): number {
    return this.interactiveStartRow;
  }

  // ── Legacy child API (backward compatible) ──────────────

  addChild(component: Component): void {
    this.root.add(component);
    this.requestRender();
  }

  removeChild(id: string): boolean {
    const removed = this.root.remove(id);
    if (removed) this.requestRender();
    return removed;
  }

  getChild(id: string): Component | undefined {
    return this.root.get(id);
  }

  getRoot(): Container {
    return this.root;
  }

  // ── Focus management ────────────────────────────────────

  setFocus(component: Component | null): void {
    if (this.focusedComponent === component) return;
    if (this.focusedComponent?.onBlur) {
      this.focusedComponent.onBlur();
    }
    this.focusedComponent = component;
    if (component?.onFocus) {
      component.onFocus();
    }
    this.requestRender();
  }

  getFocus(): Component | null {
    return this.focusedComponent;
  }

  // ── Overlay ─────────────────────────────────────────────

  showOverlay(component: Component): void {
    this.overlayComponent = component;
    component.onMount?.();
    this.requestRender();
  }

  hideOverlay(): void {
    if (this.overlayComponent) {
      this.overlayComponent.onUnmount?.();
      this.overlayComponent = null;
      this.renderer.reset();
      this.requestRender();
    }
  }

  hasOverlay(): boolean {
    return this.overlayComponent !== null;
  }

  // ── Render ──────────────────────────────────────────────

  requestRender(): void {
    if (this.renderPending || !this.running) return;
    this.renderPending = true;
    process.nextTick(() => {
      this.renderPending = false;
      if (!this.running) return;
      this.doRender();
    });
  }

  /** @deprecated Use setScrollableContent / addFixedBottom instead. */
  setScrollTarget(_component: Component | null): void {
    // No-op — scroll is managed by TUI directly in split-region mode.
    // Kept for backward compat so existing callers don't break.
  }

  getTerminal(): Terminal {
    return this.terminal;
  }

  private doRender(): void {
    DEV.beginFrame();

    // Recompute responsive layout each frame
    this.layout = computeLayout(this.terminal.columns, this.terminal.rows);

    // Minimum terminal size guard
    if (this.terminal.columns < 40 || this.terminal.rows < 10) {
      const msg = "Terminal too small. Resize to at least 40\u00d710.";
      const pad = Math.max(0, Math.floor((this.terminal.columns - msg.length) / 2));
      this.renderer.render(this.terminal, ["", " ".repeat(pad) + msg, ""]);
      this.terminal.write(hideCursor);
      DEV.endFrame();
      return;
    }

    if (this.overlayComponent) {
      this.renderOverlay();
      DEV.endFrame();
      return;
    }

    if (this.scrollableComponent) {
      this.renderSplitRegion();
    } else {
      this.renderLegacy();
    }
    DEV.endFrame();
  }

  /** Split-region render: scrollable content + fixed bottom. */
  private renderSplitRegion(): void {
    const width = this.terminal.columns;
    const totalRows = this.terminal.rows;

    // 1. Render fixed bottom → measure height
    const fixedLines: string[] = [];
    let focusOffsetInFixed = -1;
    for (const comp of this.fixedBottomComponents) {
      if (comp.hidden) continue;
      if (comp === this.focusedComponent) {
        focusOffsetInFixed = fixedLines.length;
      }
      fixedLines.push(...comp.render(width));
    }
    const fixedHeight = fixedLines.length;

    // 2. Scrollable area gets remaining rows
    const scrollableHeight = Math.max(0, totalRows - fixedHeight);

    // 3. Render scrollable content (returns ALL lines)
    //    If an interactive view is active, append it after messages
    const messageLines = this.scrollableComponent?.hidden
      ? []
      : this.scrollableComponent!.render(width);
    const allContentLines = this.interactiveLines
      ? [...messageLines, ...this.interactiveLines]
      : messageLines;

    // 4. Calculate visible window based on scrollOffset
    //    scrollOffset=0 → at bottom (show last scrollableHeight lines)
    //    scrollOffset>0 → scrolled up
    const totalContent = allContentLines.length;
    const maxScroll = Math.max(0, totalContent - scrollableHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    this.scrollOffset = Math.max(0, this.scrollOffset);

    const visibleEnd = totalContent - this.scrollOffset;
    const visibleStart = Math.max(0, visibleEnd - scrollableHeight);

    // Store full content lines for selection text extraction
    this.lastFullContentLines = allContentLines;
    const visibleContentLines = allContentLines.slice(visibleStart, visibleEnd);

    // 5. Pad with empty lines if content doesn't fill the area
    const paddedContent: string[] = [];
    const padCount = scrollableHeight - visibleContentLines.length;
    for (let i = 0; i < padCount; i++) {
      paddedContent.push("");
    }
    paddedContent.push(...visibleContentLines);

    // Set selection scroll offset AFTER calculating padding.
    // Screen row 1 is the first padded row. The first content row is at screen row (padCount + 1).
    // screenToContent(row) = row + scrollOffset, so for row = padCount + 1 we need
    // contentRow = visibleStart + 1 (1-based), meaning scrollOffset = visibleStart - padCount.
    this.selectionManager.setScrollOffset(visibleStart - padCount);

    // 5b. Track where interactive content starts on screen (1-based row)
    if (this.interactiveLines && this.scrollOffset === 0) {
      const interactiveVisibleStart = Math.max(0, messageLines.length - visibleStart);
      this.interactiveStartRow = padCount + interactiveVisibleStart + 1;
    } else {
      this.interactiveStartRow = 0;
    }

    // 5c. Track region boundaries for highlight/selection
    this.contentRowEnd = this.interactiveStartRow > 0
      ? this.interactiveStartRow - 1
      : scrollableHeight;
    // Calculate editor position within fixed area
    let editorOff = 0;
    for (const comp of this.fixedBottomComponents) {
      const h = comp.render(width).length;
      if (comp === this.focusedComponent) {
        this.editorRowStart = scrollableHeight + editorOff + 1;
        this.editorRowEnd = scrollableHeight + editorOff + h;
      }
      editorOff += h;
    }
    this.statusBarRow = totalRows;

    // 6. Combine: scrollable (top) + fixed (bottom)
    const screenLines = [...paddedContent, ...fixedLines];

    // 7. Apply selection highlight and render
    const highlighted = this.applySelectionHighlight(screenLines);
    this.lastScreenLines = screenLines;
    this.renderer.render(this.terminal, highlighted);

    // 8. Position cursor in focused component (within fixed region)
    const pos = this.focusedComponent?.getCursorPosition?.();
    if (pos && focusOffsetInFixed >= 0) {
      const row = scrollableHeight + focusOffsetInFixed + pos.row;
      if (row >= 1 && row <= totalRows) {
        this.terminal.write(cursorTo(row, pos.col));
        this.terminal.write(showCursor);
        return;
      }
    }
    this.terminal.write(hideCursor);
  }

  /** Legacy render: all children in Container, truncated to terminal height. */
  private renderLegacy(): void {
    const width = this.terminal.columns;
    const maxRows = this.terminal.rows;

    let lines: string[] = [];
    let focusOffset = 0;

    for (const child of this.root.children) {
      if (child === this.focusedComponent) {
        focusOffset = lines.length;
      }
      lines.push(...child.render(width));
    }

    let sliceStart = 0;
    if (lines.length > maxRows) {
      sliceStart = lines.length - maxRows;
      lines = lines.slice(sliceStart);
    }

    const highlighted = this.applySelectionHighlight(lines);
    this.lastScreenLines = lines;
    this.renderer.render(this.terminal, highlighted);

    const pos = this.focusedComponent?.getCursorPosition?.();
    if (pos) {
      const row = focusOffset + pos.row - sliceStart;
      if (row >= 1 && row <= maxRows) {
        this.terminal.write(cursorTo(row, pos.col));
        this.terminal.write(showCursor);
        return;
      }
    }
    this.terminal.write(hideCursor);
  }

  /** Overlay render: overlay takes the full screen. */
  private renderOverlay(): void {
    const width = this.terminal.columns;
    const maxRows = this.terminal.rows;
    let lines = this.overlayComponent!.render(width);
    if (lines.length > maxRows) {
      lines = lines.slice(lines.length - maxRows);
    }
    this.renderer.render(this.terminal, lines);
    this.terminal.write(hideCursor);
  }

  // ── Input ───────────────────────────────────────────────

  private handleEvent(event: KeyEvent): void {
    // Mouse events — separate path
    if (event.type === "mouse_click" || event.type === "mouse_drag" || event.type === "mouse_release") {
      this.handleMouse(event);
      return;
    }

    if (event.type === "scroll_up" || event.type === "scroll_down") {
      // If scroll is in the editor region, scroll editor content instead
      const scrollRow = (event as { row?: number }).row ?? 0;
      if (scrollRow >= this.editorRowStart && scrollRow <= this.editorRowEnd) {
        const editor = this.focusedComponent as Component & { scrollInput?: (delta: number) => boolean };
        const delta = event.type === "scroll_up" ? -3 : 3;
        if (editor?.scrollInput?.(delta)) {
          this.requestRender();
          return;
        }
      }
      if (this.scrollableComponent) {
        if (event.type === "scroll_up") this.scrollUp(3);
        else this.scrollDown(3);
      }
      return;
    }

    // Resolve key → action (for app-level and scroll actions only)
    const ctx = this.buildKeyContext();
    const action = this.keybindings.resolve(event, ctx);

    // App-level actions handled by TUI (quit, abort, scroll, modes)
    if (action && this.handleAppAction(action, event)) return;

    // Clear selection on keyboard input
    if (this.selectionManager.hasSelection() && !this.selectionManager.isSelecting()) {
      this.selectionManager.clearSelection();
      this.requestRender();
    }

    // Key handler stack — interactive views get priority
    for (let i = this.keyHandlerStack.length - 1; i >= 0; i--) {
      if (this.keyHandlerStack[i]!.handleKey(event)) {
        this.requestRender();
        return;
      }
    }

    // Route to focused component (editor handles its own keybindings)
    const target = this.overlayComponent ?? this.focusedComponent;
    if (target?.onKey?.(event)) {
      this.requestRender();
      return;
    }

    // Tab to cycle focus
    if (event.type === "tab" && !this.overlayComponent) {
      this.cycleFocus("shift" in event ? event.shift : false);
      return;
    }
  }

  /** Handle app-level actions that the TUI manages directly. Returns true if consumed. */
  private handleAppAction(action: ActionId, _event: KeyEvent): boolean {
    if (action === "app.quit") { this.gracefulExit(); return true; }
    if (action === "app.abort") { this.handleCtrlC(); return true; }
    if (action === "app.cancel" && this.keyHandlerStack.length > 0) {
      this.keyHandlerStack[this.keyHandlerStack.length - 1]!.handleKey({ type: "escape" });
      this.requestRender();
      return true;
    }

    // Clipboard copy — check editor selection first, then messages selection
    if (action === "editor.clipboard.copy") {
      const editor = this.focusedComponent as Component & { hasSelection?: () => boolean; getSelectedText?: () => string | null; clearSelection?: () => void };
      if (editor?.hasSelection?.()) {
        const text = editor.getSelectedText?.();
        if (text?.trim()) {
          void this.copyManager.copyToClipboard(text);
          this.onFlashMessage?.("Copied!");
        }
        editor.clearSelection?.();
        this.requestRender();
        return true;
      }
      if (this.selectionManager.hasSelection()) {
        const raw = this.selectionManager.getSelectedText(this.lastFullContentLines);
        const text = cleanCopyText(raw);
        if (text.trim()) {
          void this.copyManager.copyToClipboard(text);
          this.onFlashMessage?.("Copied!");
        }
        this.selectionManager.clearSelection();
        this.requestRender();
        return true;
      }
    }

    // Messages scroll
    if (action === "messages.scroll.up") { this.scrollUp(3); return true; }
    if (action === "messages.scroll.down") { this.scrollDown(3); return true; }
    if (action === "messages.scroll.pageUp") {
      this.scrollUp(Math.max(1, this.terminal.rows - this.getFixedHeight() - 1));
      return true;
    }
    if (action === "messages.scroll.pageDown") {
      this.scrollDown(Math.max(1, this.terminal.rows - this.getFixedHeight() - 1));
      return true;
    }
    if (action === "messages.scroll.top") { this.scrollUp(999999); return true; }
    if (action === "messages.scroll.bottom") { this.scrollToBottom(); return true; }
    if (action === "messages.scroll.prevPrompt" || action === "messages.scroll.nextPrompt") {
      const dir = action === "messages.scroll.prevPrompt" ? "prev" : "next";
      const targetLine = this.onScrollToPrompt?.(dir);
      if (targetLine != null) {
        // Convert content line index to scroll offset
        const totalLines = this.lastFullContentLines.length;
        const visibleHeight = this.terminal.rows - this.getFixedHeight();
        this.scrollOffset = Math.max(0, totalLines - targetLine - visibleHeight);
        this.autoScroll = this.scrollOffset === 0;
        this.updateBreadcrumb();
        this.requestRender();
      }
      return true;
    }
    if (action === "messages.collapse.toggle") {
      if (this.onToggleCollapse?.()) {
        this.requestRender();
      }
      return true;
    }

    // Mode switching — delegate to app layer via callback
    if (action.startsWith("mode.")) {
      this.onModeAction?.(action.replace("mode.", ""));
      return true;
    }

    // Navigation actions → route to key handler stack as synthetic events
    if (action.startsWith("nav.") && this.keyHandlerStack.length > 0) {
      const navEvent = this.actionToKeyEvent(action);
      if (navEvent) {
        for (let i = this.keyHandlerStack.length - 1; i >= 0; i--) {
          if (this.keyHandlerStack[i]!.handleKey(navEvent)) {
            this.requestRender();
            return true;
          }
        }
      }
      return true;
    }

    // All other actions (editor.*, etc.) → not handled here, fall through to component
    return false;
  }

  private buildKeyContext(): KeyContext {
    const fc = this.focusedComponent as Component & {
      isAutocompleteActive?: () => boolean;
      hasSelection?: () => boolean;
    };
    return {
      hasSelection: this.selectionManager.hasSelection() || (fc?.hasSelection?.() ?? false),
      hasRunningTask: !!this.onAbort,
      hasActiveView: this.keyHandlerStack.length > 0,
      isAutocompleteVisible: fc?.isAutocompleteActive?.() ?? false,
      isEditing: false,
    };
  }

  /** Convert a nav action to a synthetic KeyEvent for the view stack. */
  private actionToKeyEvent(action: ActionId): KeyEvent | null {
    switch (action) {
      case "nav.up": return { type: "arrow", direction: "up", ctrl: false, alt: false };
      case "nav.down": return { type: "arrow", direction: "down", ctrl: false, alt: false };
      case "nav.select": return { type: "enter", shift: false };
      case "nav.back": return { type: "escape" };
      default: return null;
    }
  }

  /** Contextual Ctrl+C: copy selection → close view → abort task → exit. */
  private handleCtrlC(): void {
    // Priority 0a: If there's a message-area text selection → copy to clipboard
    if (this.selectionManager.hasSelection()) {
      const raw = this.selectionManager.getSelectedText(this.lastFullContentLines);
      const text = cleanCopyText(raw);

      if (text.trim()) {
        void this.copyManager.copyToClipboard(text);
        this.onFlashMessage?.("Copied!");
      }
      this.selectionManager.clearSelection();
      this.requestRender();
      return;
    }

    // Priority 0b: If the editor has a text selection → copy to clipboard
    const editor = this.focusedComponent as Component & { hasSelection?: () => boolean; getSelectedText?: () => string | null };
    if (editor?.hasSelection?.()) {
      const text = editor.getSelectedText?.();
      if (text?.trim()) {
        void this.copyManager.copyToClipboard(text);
        this.onFlashMessage?.("Copied!");
      }
      this.requestRender();
      return;
    }

    // Priority 1: If an interactive view is open → send Ctrl+C to close it
    if (this.keyHandlerStack.length > 0) {
      const top = this.keyHandlerStack[this.keyHandlerStack.length - 1]!;
      top.handleKey({ type: "char", char: "c", ctrl: true, alt: false, shift: false });
      this.requestRender();
      return;
    }

    // Priority 2: If a task is running → abort it
    if (this.onAbort?.()) {
      return;
    }

    // Priority 3: Exit immediately
    this.gracefulExit();
  }

  /** Catch uncaught errors — show in TUI instead of crashing to raw terminal. */
  private handleUncaughtError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      this.onSystemMessage?.(`Internal error: ${msg}. Type /error for details.`);
      this.requestRender();
    } catch {
      // Last resort: restore terminal and log to stderr
      this.terminal.write(showCursor);
      this.terminal.stop();
      process.stderr.write(`\nOpenPawl internal error: ${msg}\n`);
    }
  }

  private gracefulExit(): void {
    this.onExit?.();
    this.stop();
  }

  // ── Region classification + selection highlight ────────

  /** Classify a screen row: 'content' (messages/editor), 'interactive', or 'none'. */
  private getRegionType(row: number): "content" | "interactive" | "none" {
    if (row >= 1 && row <= this.contentRowEnd) return "content"; // messages
    if (this.interactiveStartRow > 0 && row >= this.interactiveStartRow && row <= (this.contentRowEnd + (this.interactiveLines?.length ?? 0))) return "interactive";
    if (row >= this.editorRowStart && row <= this.editorRowEnd) return "content"; // editor
    if (row === this.statusBarRow) return "interactive"; // status bar
    return "none"; // divider or out of bounds
  }

  /** Apply selection highlight in content regions. */
  private applySelectionHighlight(screenLines: string[]): string[] {
    if (!this.selectionManager.hasSelection()) return screenLines;

    return screenLines.map((line, idx) => {
      const row = idx + 1;
      const region = this.getRegionType(row);
      if (region !== "content") return line;
      if (row >= this.editorRowStart && row <= this.editorRowEnd) return line;

      let result = "";
      let visCol = 0;
      let inEsc = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === "\x1b") { inEsc = true; result += ch; continue; }
        if (inEsc) { result += ch; if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) inEsc = false; continue; }
        visCol++;
        if (this.selectionManager.isSelected(row, visCol)) {
          result += `\x1b[7m${ch}\x1b[27m`;
        } else {
          result += ch;
        }
      }
      return result;
    });
  }

  // ── Mouse handling ─────────────────────────────────────

  private handleMouse(event: KeyEvent): void {
    if (event.type === "mouse_click" && "button" in event) {
      if (event.button !== "left") return;

      // Multi-click detection
      const now = Date.now();
      const samePos = event.row === this.lastClickRow && Math.abs(event.col - this.lastClickCol) <= 1;
      this.clickCount = (samePos && now - this.lastClickTime < 400) ? this.clickCount + 1 : 1;
      this.lastClickTime = now;
      this.lastClickRow = event.row;
      this.lastClickCol = event.col;

      const region = this.getRegionType(event.row);
      this.selectionManager.clearSelection();

      if (region === "content" && event.row < this.editorRowStart) {
        // Messages region
        if (this.clickCount === 1) {
          this.mouseDownPos = { row: event.row, col: event.col };
          this.isDragging = false;
        } else if (this.clickCount === 2) {
          this.mouseDownPos = null;
          this.selectionManager.selectWordAt(event.row, event.col, this.lastScreenLines);
        } else if (this.clickCount >= 3) {
          this.mouseDownPos = null;
          this.selectionManager.selectLine(event.row, this.lastScreenLines);
        }
      } else if (region === "content" && event.row >= this.editorRowStart && event.row <= this.editorRowEnd) {
        // Editor region — position cursor
        const editor = this.focusedComponent as Component & { setCursorFromClick?: (relativeRow: number, col: number) => void };
        editor.setCursorFromClick?.(event.row - this.editorRowStart - 1, event.col);
      }

      this.requestRender();
      return;
    }

    if (event.type === "mouse_drag" && "col" in event) {
      // Lazy drag: start selection on first move from mousedown position
      if (this.mouseDownPos && !this.isDragging) {
        const moved = event.row !== this.mouseDownPos.row || event.col !== this.mouseDownPos.col;
        if (moved) {
          this.isDragging = true;
          this.selectionManager.startSelection(this.mouseDownPos.row, this.mouseDownPos.col);
        }
      }
      if (this.isDragging && this.selectionManager.isSelecting()) {
        // Clamp drag to messages area
        const row = Math.min(event.row, this.contentRowEnd);
        this.selectionManager.updateSelection(row, event.col);

        // Auto-scroll when dragging near edges
        if (event.row <= 1) {
          this.startAutoScroll("up");
        } else if (event.row >= this.terminal.rows - this.getFixedHeight()) {
          this.startAutoScroll("down");
        } else {
          this.stopAutoScroll();
        }

        this.requestRender();
      }
      return;
    }

    if (event.type === "mouse_release") {
      this.stopAutoScroll();
      if (this.isDragging && this.selectionManager.isSelecting()) {
        this.selectionManager.endSelection();
        // Copy selection to clipboard
        const text = this.selectionManager.getSelectedText(this.lastFullContentLines);
        if (text) {
          void this.copyManager.copyToClipboard(text);
          this.onFlashMessage?.("Copied!");
        }
      }
      this.mouseDownPos = null;
      this.isDragging = false;
      this.requestRender();
      return;
    }
  }

  private startAutoScroll(direction: "up" | "down"): void {
    if (this.autoScrollTimer) return;
    this.autoScrollTimer = setInterval(() => {
      if (direction === "up") this.scrollUp(2);
      else this.scrollDown(2);
      this.requestRender();
    }, 80);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer) {
      clearInterval(this.autoScrollTimer);
      this.autoScrollTimer = null;
    }
  }

  private getFixedHeight(): number {
    if (this.fixedBottomComponents.length === 0) return 0;
    const width = this.terminal.columns;
    let h = 0;
    for (const comp of this.fixedBottomComponents) {
      h += comp.render(width).length;
    }
    return h;
  }

  private cycleFocus(reverse: boolean): void {
    const focusable = this.fixedBottomComponents.length > 0
      ? this.fixedBottomComponents.filter((c) => c.focusable)
      : this.root.children.filter((c) => c.focusable);
    if (focusable.length === 0) return;

    const currentIdx = this.focusedComponent
      ? focusable.indexOf(this.focusedComponent)
      : -1;

    let nextIdx: number;
    if (reverse) {
      nextIdx = currentIdx <= 0 ? focusable.length - 1 : currentIdx - 1;
    } else {
      nextIdx = currentIdx >= focusable.length - 1 ? 0 : currentIdx + 1;
    }

    this.setFocus(focusable[nextIdx]!);
  }
}

function detectPlatform(): PresetName {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "windows";
  return "linux";
}
