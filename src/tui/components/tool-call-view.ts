/**
 * ToolCallView — renders a single tool execution inline in the chat.
 * Shows spinner → result with collapsible output.
 */

import type { DiffResult, DiffLine } from "../../utils/diff.js";
import { defaultTheme, ctp } from "../themes/default.js";
import { ICONS } from "../constants/icons.js";
import { renderMoreLines } from "../utils/scroll-indicators.js";

export interface ToolCallViewState {
  executionId: string;
  toolName: string;
  agentId: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  inputSummary: string;
  progressMessage?: string;
  outputSummary?: string;
  fullOutput?: string;
  duration?: number;
  expanded: boolean;
  diff?: DiffResult;
}

// Completed-tense verbs for each tool
const TOOL_VERBS: Record<string, [string, string]> = {
  // [completed verb, running verb]
  file_read:    ["Read", "Reading"],
  file_write:   ["Wrote", "Writing"],
  file_edit:    ["Edited", "Editing"],
  file_list:    ["Listed", "Listing"],
  shell_exec:   ["Ran", "Running"],
  execute_code: ["Executed", "Executing"],
  git_ops:      ["Git", "Git"],
  web_search:   ["Searched", "Searching"],
  web_fetch:    ["Fetched", "Fetching"],
  grep_search:  ["Searched", "Searching"],
  list_dir:     ["Listed", "Listing"],
};

const BRAILLE_SPINNER = ICONS.brailleFrames;

export class ToolCallView {
  private state: ToolCallViewState;
  private spinnerFrame = 0;

  constructor(init: Omit<ToolCallViewState, "expanded">) {
    this.state = { ...init, expanded: false };
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const { status, inputSummary, duration, expanded, fullOutput, outputSummary, diff } = this.state;

    const icon = this.getIcon();
    const iconColor = this.getIconColor();
    const verb = this.getVerb();
    const target = inputSummary.slice(0, Math.min(50, width - 20));
    const durationStr = duration && duration > 100 ? ` ${formatDuration(duration)}` : "";

    // Diff counts (e.g., "(+45 -12)")
    const diffCountStr = diff && (diff.added > 0 || diff.removed > 0)
      ? ` ${ctp.green(`+${diff.added}`)} ${ctp.red(`-${diff.removed}`)}`
      : "";

    // Determine if diff block is expandable
    const diffLineCount = diff?.lines.length ?? 0;
    const hasDiffLines = diffLineCount > 0;
    const autoShowDiff = hasDiffLines && diffLineCount <= 10;
    const showDiff = autoShowDiff || (expanded && hasDiffLines);

    // Expand indicator (diff or fullOutput)
    const canExpand = (hasDiffLines && !autoShowDiff) || (!!fullOutput && fullOutput.split("\n").length > 1);
    const expandHint = canExpand
      ? (expanded ? `  ${ICONS.expand}` : `  ${ICONS.cursor}`)
      : "";

    // Main line: "  ✓ Wrote src/server.ts +45 -12 (0.3s)"
    const suffix = status === "running" ? "..." : "";
    const mainContent = `  ${iconColor(icon)} ${verb} ${target}${diffCountStr}${suffix}${durationStr}${expandHint}`;
    lines.push(mainContent);

    // Error summary (failed state)
    if (status === "failed" && outputSummary) {
      lines.push(`    ${defaultTheme.error(outputSummary.slice(0, width - 6))}`);
    }

    // Diff block (for file_write/file_edit)
    if (showDiff && diff) {
      for (const dl of diff.lines) {
        lines.push(`  ${defaultTheme.dim("│")} ${renderDiffLine(dl)}`);
      }
    }

    // Expanded output (non-diff tools, or if no diff lines)
    if (expanded && fullOutput && !showDiff) {
      const outputLines = fullOutput.split("\n");
      const maxVisible = 25;

      if (outputLines.length <= maxVisible) {
        for (const line of outputLines) {
          lines.push(`  ${defaultTheme.dim("│")} ${line}`);
        }
      } else {
        for (const line of outputLines.slice(0, 15)) {
          lines.push(`  ${defaultTheme.dim("│")} ${line}`);
        }
        lines.push(`  ${defaultTheme.dim("│")} ${renderMoreLines(outputLines.length - 20)}`);
        for (const line of outputLines.slice(-5)) {
          lines.push(`  ${defaultTheme.dim("│")} ${line}`);
        }
      }
    }

    return lines;
  }

  updateProgress(message: string): void {
    this.state.progressMessage = message;
  }

  complete(output: { success: boolean; summary: string; fullOutput?: string; duration: number; diff?: DiffResult }): void {
    this.state.status = output.success ? "completed" : "failed";
    this.state.outputSummary = output.summary;
    this.state.fullOutput = output.fullOutput;
    this.state.duration = output.duration;
    this.state.diff = output.diff;
  }

  abort(): void {
    this.state.status = "aborted";
  }

  toggleExpand(): void {
    this.state.expanded = !this.state.expanded;
  }

  setExpanded(state: boolean): void {
    this.state.expanded = state;
  }

  advanceSpinner(): void {
    this.spinnerFrame++;
  }

  get isExpanded(): boolean { return this.state.expanded; }
  get executionId(): string { return this.state.executionId; }
  get status(): string { return this.state.status; }

  /** Render a single compact line for baking into chat history. */
  renderOneLiner(): string {
    const icon = this.getIcon();
    const iconColor = this.getIconColor();
    const verb = this.getVerb();
    const target = this.state.inputSummary.slice(0, 50);
    const { diff } = this.state;
    const diffStr = diff && (diff.added > 0 || diff.removed > 0)
      ? ` ${ctp.green(`+${diff.added}`)} ${ctp.red(`-${diff.removed}`)}`
      : "";
    const dur = this.state.duration && this.state.duration > 100
      ? ` ${formatDuration(this.state.duration)}`
      : "";
    return `${iconColor(icon)} ${verb} ${target}${diffStr}${dur}`;
  }

  private getIcon(): string {
    switch (this.state.status) {
      case "pending": return defaultTheme.symbols.pending;
      case "running": return BRAILLE_SPINNER[this.spinnerFrame % BRAILLE_SPINNER.length]!;
      case "completed": return defaultTheme.symbols.success;
      case "failed": return defaultTheme.symbols.error;
      case "aborted": return ICONS.aborted;
    }
  }

  private getIconColor(): (s: string) => string {
    switch (this.state.status) {
      case "pending": return ctp.surface2;
      case "running": return ctp.teal;
      case "completed": return ctp.green;
      case "failed": return ctp.red;
      case "aborted": return ctp.surface2;
    }
  }

  private getVerb(): string {
    const entry = TOOL_VERBS[this.state.toolName];
    if (entry) {
      return this.state.status === "running" ? entry[1] : entry[0];
    }
    // Fallback: use toolName directly
    const name = this.state.toolName.replace(/_/g, " ");
    return this.state.status === "running" ? name + "..." : name;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  // Tool calls show decimal seconds for precision
  const label = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  return defaultTheme.dim(`(${label})`);
}

function renderDiffLine(dl: DiffLine): string {
  switch (dl.type) {
    case "added":
      return ctp.green(`+ ${dl.content}`);
    case "removed":
      return ctp.red(`- ${dl.content}`);
    case "context":
      return defaultTheme.dim(`  ${dl.content}`);
    case "collapsed":
      return defaultTheme.dim(`  ... ${dl.content} ...`);
  }
}
