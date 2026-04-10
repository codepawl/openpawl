/**
 * Session picker — select, create, or delete sessions.
 * Shown on startup (2+ sessions) and via /sessions command.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { ctp } from "../../tui/themes/default.js";
import { separator } from "../../tui/primitives/separator.js";
import { renderConfirmPrompt } from "../../tui/primitives/confirm.js";
import type { SessionListItem } from "../../session/session-state.js";
import { ScrollableFilterList } from "../../tui/components/scrollable-filter-list.js";

export interface SessionPickerResult {
  action: "resume" | "new" | "delete" | "clear-all" | "cancel";
  sessionId?: string;
}

export class SessionPickerView extends InteractiveView {
  private onResult: (result: SessionPickerResult) => void;
  private sessions: SessionListItem[];
  private activeSessionId: string | undefined;
  private confirmingDelete: string | null = null;
  private confirmingClearAll = false;
  private list: ScrollableFilterList<SessionListItem>;

  constructor(
    tui: TUI,
    sessions: SessionListItem[],
    onResult: (result: SessionPickerResult) => void,
    onClose: () => void,
    activeSessionId?: string,
  ) {
    super(tui, onClose);
    this.sessions = sessions;
    this.onResult = onResult;
    this.activeSessionId = activeSessionId;
    this.fullscreen = true;
    this.list = new ScrollableFilterList<SessionListItem>({
      renderItem: (s, _index, selected) => this.renderSessionItem(s, selected),
      filterFn: (s, query) => {
        const q = query.toLowerCase();
        return (s.title || "Untitled").toLowerCase().includes(q)
          || formatRelativeTime(s.updatedAt).toLowerCase().includes(q);
      },
      emptyMessage: "No sessions.",
      filterPlaceholder: "Type to search sessions...",
      showFilter: sessions.length >= 5,
    });
    this.list.setItems(sessions);
  }

  /** Number of sessions that would be deleted by "Clear All" (excludes active). */
  private get clearableCount(): number {
    return this.sessions.filter((s) => s.id !== this.activeSessionId).length;
  }

  /** Whether the "Clear All" option should be shown. */
  private get showClearAll(): boolean {
    return this.clearableCount > 0;
  }

  /** Filtered session count (changes with filter text). */
  private get filteredSessionCount(): number {
    return this.list.getFilteredCount(this.filterText);
  }

  override activate(): void {
    this.filterEnabled = this.sessions.length >= 5;
    this.filterText = "";
    super.activate();
  }

  protected getItemCount(): number {
    // filtered sessions + "New session" + optional "Clear All"
    return this.filteredSessionCount + 1 + (this.showClearAll ? 1 : 0);
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    // Clear All confirmation: intercept y/n/Esc
    if (this.confirmingClearAll) {
      if (event.type === "char" && event.char === "y" && !event.ctrl) {
        this.onResult({ action: "clear-all" });
        this.deactivate();
        return true;
      }
      if (event.type === "char" && event.char === "n" && !event.ctrl) {
        this.confirmingClearAll = false;
        this.render();
        return true;
      }
      if (event.type === "escape") {
        this.confirmingClearAll = false;
        this.render();
        return true;
      }
      return true; // consume all other keys during confirmation
    }

    if (event.type === "enter") {
      if (this.confirmingDelete) {
        this.onResult({ action: "delete", sessionId: this.confirmingDelete });
        this.deactivate();
        return true;
      }
      const sessionCount = this.filteredSessionCount;
      // "Clear All" item: last item when shown
      const clearAllIndex = this.showClearAll ? sessionCount + 1 : -1;
      if (this.selectedIndex === clearAllIndex) {
        this.confirmingClearAll = true;
        this.render();
        return true;
      }
      if (this.selectedIndex >= sessionCount) {
        this.onResult({ action: "new" });
      } else {
        const filtered = this.list.getFilteredItems(this.filterText);
        const session = filtered[this.selectedIndex];
        if (session) this.onResult({ action: "resume", sessionId: session.id });
      }
      this.deactivate();
      return true;
    }

    // Delete key or 'd' key (only on session items, not action items)
    if (
      (event.type === "delete" || (event.type === "char" && event.char === "d" && !event.ctrl)) &&
      this.selectedIndex < this.filteredSessionCount
    ) {
      const filtered = this.list.getFilteredItems(this.filterText);
      const session = filtered[this.selectedIndex];
      if (session) {
        if (this.confirmingDelete === session.id) {
          this.onResult({ action: "delete", sessionId: session.id });
          this.deactivate();
        } else {
          this.confirmingDelete = session.id;
          this.render();
        }
      }
      return true;
    }

    if (event.type === "arrow") {
      this.confirmingDelete = null;
    }

    return true;
  }

  protected override getPanelTitle(): string { return "Sessions"; }
  protected override getPanelFooter(): string {
    if (this.confirmingClearAll) {
      return `Delete all ${this.clearableCount} sessions? y confirm \u00b7 n cancel`;
    }
    if (this.confirmingDelete) {
      return renderConfirmPrompt({
        message: "Delete?",
        confirmLabel: "Enter",
        cancelLabel: "Esc",
        dangerLevel: "danger",
      }).replace(/\x1b\[[0-9;]*m/g, ""); // footer is styled by panel, strip ANSI
    }
    const filterHint = this.filterEnabled ? " \u00b7 Type to filter" : "";
    return `\u2191\u2193 navigate  Enter select  d delete${filterHint}  Esc cancel`;
  }

  private renderSessionItem(s: SessionListItem, selected: boolean): string {
    const t = this.theme;
    const title = (s.title || "Untitled").slice(0, 45);
    const meta = `${s.messageCount} msgs  ${formatRelativeTime(s.updatedAt)}`;

    // Delete-confirming item: show in red
    if (this.confirmingDelete === s.id) {
      return `    ${ctp.mauve("\u276f ")}${ctp.red(title)}  ${ctp.red("press Enter to delete")}`;
    }

    const cursor = selected ? ctp.mauve("\u276f ") : "  ";
    const label = selected ? ctp.text(title) : ctp.overlay1(title);
    const metaStr = "  " + t.dim(meta);
    return `    ${cursor}${label}${metaStr}`;
  }

  protected renderLines(): string[] {
    const width = this.tui.getTerminal().columns;
    const innerW = Math.min(70, width - 10);

    // Render session list via ScrollableFilterList
    const sessionCount = this.filteredSessionCount;
    const result = this.list.renderLines({
      filterText: this.filterText,
      selectedIndex: this.selectedIndex,
      scrollOffset: this.scrollOffset,
      maxVisible: this.maxVisible,
    });

    // Separator + "New session" row (always after session list)
    const newSessionIndex = sessionCount;
    if (this.sessions.length > 0) {
      result.push(separator({ width: Math.min(40, innerW), padding: 4 }));
    }
    const isNewSelected = this.selectedIndex === newSessionIndex;
    const cursor = isNewSelected ? ctp.mauve("\u276f ") : "  ";
    const label = isNewSelected ? ctp.green("+  New session") : this.theme.dim("+  New session");
    result.push(`    ${cursor}${label}`);

    // "Clear All Sessions" option
    if (this.showClearAll) {
      const clearAllIndex = newSessionIndex + 1;
      const isClearSelected = this.selectedIndex === clearAllIndex;
      const clearCursor = isClearSelected ? ctp.mauve("\u276f ") : "  ";
      if (this.confirmingClearAll) {
        result.push(`    ${clearCursor}${ctp.red(`\u26a0  Delete all ${this.clearableCount} sessions? y/n`)}`);
      } else {
        const clearLabel = isClearSelected
          ? ctp.red("\u26a0  Clear all sessions")
          : this.theme.dim("\u26a0  Clear all sessions");
        result.push(`    ${clearCursor}${clearLabel}`);
      }
    }

    result.push("");
    return result;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w ago`;
  const diffMonth = Math.floor(diffDay / 30);
  return `${diffMonth}mo ago`;
}
