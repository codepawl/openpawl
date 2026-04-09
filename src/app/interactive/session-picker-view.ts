/**
 * Session picker — select, create, or delete sessions.
 * Shown on startup (2+ sessions) and via /sessions command.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { ctp } from "../../tui/themes/default.js";
import { visibleWidth } from "../../tui/utils/text-width.js";
import type { SessionListItem } from "../../session/session-state.js";

export interface SessionPickerResult {
  action: "resume" | "new" | "delete" | "cancel";
  sessionId?: string;
}

export class SessionPickerView extends InteractiveView {
  private onResult: (result: SessionPickerResult) => void;
  private sessions: SessionListItem[];
  private confirmingDelete: string | null = null;

  constructor(
    tui: TUI,
    sessions: SessionListItem[],
    onResult: (result: SessionPickerResult) => void,
    onClose: () => void,
  ) {
    super(tui, onClose);
    this.sessions = sessions;
    this.onResult = onResult;
    this.fullscreen = true;
  }

  // Items: sessions + "New session" row
  protected getItemCount(): number {
    return this.sessions.length + 1;
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      if (this.confirmingDelete) {
        // Confirm delete
        this.onResult({ action: "delete", sessionId: this.confirmingDelete });
        this.deactivate();
        return true;
      }

      if (this.selectedIndex >= this.sessions.length) {
        // "New session" selected
        this.onResult({ action: "new" });
        this.deactivate();
      } else {
        const session = this.sessions[this.selectedIndex];
        if (session) {
          this.onResult({ action: "resume", sessionId: session.id });
          this.deactivate();
        }
      }
      return true;
    }

    // Delete key or 'd' key
    if (
      (event.type === "delete" || (event.type === "char" && event.char === "d" && !event.ctrl)) &&
      this.selectedIndex < this.sessions.length
    ) {
      const session = this.sessions[this.selectedIndex];
      if (session) {
        if (this.confirmingDelete === session.id) {
          // Second press confirms
          this.onResult({ action: "delete", sessionId: session.id });
          this.deactivate();
        } else {
          this.confirmingDelete = session.id;
          this.render();
        }
      }
      return true;
    }

    // Any navigation clears delete confirmation
    if (event.type === "arrow") {
      this.confirmingDelete = null;
    }

    return true;
  }

  protected override getPanelTitle(): string { return "Sessions"; }
  protected override getPanelFooter(): string {
    if (this.confirmingDelete) return "Press Enter to permanently delete this session, or Esc to keep it";
    return "\u2191\u2193 navigate  Enter select  d delete  Esc cancel";
  }

  protected renderLines(): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const width = this.tui.getTerminal().columns;
    const maxTitleW = Math.min(45, Math.floor(width * 0.45));

    const { start, end, aboveCount, belowCount } = this.getVisibleRange();
    const itemLines: string[] = [];

    // Render session rows
    for (let vi = start; vi < end && vi < this.sessions.length; vi++) {
      const session = this.sessions[vi]!;
      const isSelected = vi === this.selectedIndex;
      const isDeleting = this.confirmingDelete === session.id;

      const cursor = isSelected ? ctp.mauve("\u25b8 ") : "  ";
      const title = truncate(session.title || "Untitled", maxTitleW);
      const msgs = `${session.messageCount} msgs`;
      const time = formatRelativeTime(session.updatedAt);
      const meta = t.dim(`${msgs.padEnd(10)}${time}`);

      if (isDeleting) {
        itemLines.push(`    ${cursor}${ctp.red(title)}  ${meta}  ${ctp.red("Delete? Enter/Esc")}`);
      } else if (isSelected) {
        itemLines.push(`    ${cursor}${ctp.text(title)}  ${meta}`);
      } else {
        itemLines.push(`    ${cursor}${ctp.overlay1(title)}  ${meta}`);
      }
    }

    // "New session" row
    if (end > this.sessions.length || this.sessions.length < this.maxVisible) {
      const isSelected = this.selectedIndex >= this.sessions.length;
      const cursor = isSelected ? ctp.mauve("\u25b8 ") : "  ";
      if (this.sessions.length > 0) {
        itemLines.push(`    ${t.dim("\u2500".repeat(Math.min(40, maxTitleW)))}`);
      }
      const label = isSelected ? ctp.green("+  New session") : t.dim("+  New session");
      itemLines.push(`    ${cursor}${label}`);
    }

    const withScroll = this.addScrollIndicators(itemLines, aboveCount, belowCount);
    lines.push(...withScroll);
    lines.push("");
    return lines;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s.padEnd(max);
  return s.slice(0, max - 1) + "\u2026";
}

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
