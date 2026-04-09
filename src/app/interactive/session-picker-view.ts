/**
 * Session picker — select, create, or delete sessions.
 * Shown on startup (2+ sessions) and via /sessions command.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { ctp } from "../../tui/themes/default.js";
import { separator } from "../../tui/primitives/separator.js";
import { renderSelectableList, type SelectableItem } from "../../tui/primitives/selectable-list.js";
import { renderConfirmPrompt } from "../../tui/primitives/confirm.js";
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

  protected getItemCount(): number {
    return this.sessions.length + 1; // sessions + "New session"
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      if (this.confirmingDelete) {
        this.onResult({ action: "delete", sessionId: this.confirmingDelete });
        this.deactivate();
        return true;
      }
      if (this.selectedIndex >= this.sessions.length) {
        this.onResult({ action: "new" });
      } else {
        const session = this.sessions[this.selectedIndex];
        if (session) this.onResult({ action: "resume", sessionId: session.id });
      }
      this.deactivate();
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
    if (this.confirmingDelete) {
      return renderConfirmPrompt({
        message: "Delete this session permanently?",
        confirmLabel: "Enter",
        cancelLabel: "Esc",
        dangerLevel: "danger",
      }).replace(/\x1b\[[0-9;]*m/g, ""); // footer is styled by panel, strip ANSI
    }
    return "\u2191\u2193 navigate  Enter select  d delete  Esc cancel";
  }

  protected renderLines(): string[] {
    const width = this.tui.getTerminal().columns;
    const innerW = Math.min(70, width - 10);

    // Build selectable items from sessions
    const items: SelectableItem[] = this.sessions.map((s) => ({
      id: s.id,
      label: (s.title || "Untitled").slice(0, 45),
      meta: `${s.messageCount} msgs  ${formatRelativeTime(s.updatedAt)}`,
    }));

    // Mark delete-confirming item
    const deleteIdx = this.confirmingDelete
      ? this.sessions.findIndex((s) => s.id === this.confirmingDelete)
      : -1;

    // Render session list (without "New session" — that's separate)
    const { start, end, aboveCount, belowCount } = this.getVisibleRange();
    const sessionEnd = Math.min(end, this.sessions.length);

    const listLines = renderSelectableList({
      items: items.slice(start, sessionEnd),
      selectedIndex: this.selectedIndex - start,
      width: innerW,
      scrollIndicators: false, // we handle these ourselves
    });

    // Highlight delete-confirming item in red
    if (deleteIdx >= start && deleteIdx < sessionEnd) {
      const relIdx = deleteIdx - start;
      if (relIdx < listLines.length) {
        listLines[relIdx] = listLines[relIdx]!.replace(/\x1b\[38;2;\d+;\d+;\d+m/g, "") ;
        // Re-render the line with red
        const s = this.sessions[deleteIdx]!;
        listLines[relIdx] = `    ${ctp.mauve("\u276f ")}${ctp.red((s.title || "Untitled").slice(0, 45))}  ${ctp.red("press Enter to delete")}`;
      }
    }

    const result = this.addScrollIndicators(listLines, aboveCount, belowCount);

    // Separator + "New session" row
    if (sessionEnd >= this.sessions.length) {
      if (this.sessions.length > 0) {
        result.push(separator({ width: Math.min(40, innerW), padding: 4 }));
      }
      const isSelected = this.selectedIndex >= this.sessions.length;
      const cursor = isSelected ? ctp.mauve("\u276f ") : "  ";
      const label = isSelected ? ctp.green("+  New session") : this.theme.dim("+  New session");
      result.push(`    ${cursor}${label}`);
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
