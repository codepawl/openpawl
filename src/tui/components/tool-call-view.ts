/**
 * ToolCallView — renders a single tool execution inline in the chat.
 * Shows spinner → result with collapsible output.
 */

import { defaultTheme, ctp } from "../themes/default.js";

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

const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ToolCallView {
  private state: ToolCallViewState;
  private spinnerFrame = 0;

  constructor(init: Omit<ToolCallViewState, "expanded">) {
    this.state = { ...init, expanded: false };
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const { status, inputSummary, duration, expanded, fullOutput, outputSummary } = this.state;

    const icon = this.getIcon();
    const iconColor = this.getIconColor();
    const verb = this.getVerb();
    const target = inputSummary.slice(0, Math.min(50, width - 20));
    const durationStr = duration && duration > 100 ? ` ${formatDuration(duration)}` : "";

    // Expand indicator
    const canExpand = !!fullOutput && fullOutput.split("\n").length > 1;
    const expandHint = canExpand
      ? (expanded ? "  ▾" : "  ▸")
      : "";

    // Main line: "  ⠋ Reading README.md...  (0.2s)"
    const suffix = status === "running" ? "..." : "";
    const mainContent = `  ${iconColor(icon)} ${verb} ${target}${suffix}${durationStr}${expandHint}`;
    lines.push(mainContent);

    // Error summary (failed state)
    if (status === "failed" && outputSummary) {
      lines.push(`    ${defaultTheme.error(outputSummary.slice(0, width - 6))}`);
    }

    // Expanded output
    if (expanded && fullOutput) {
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
        lines.push(`  ${defaultTheme.dim("│")} ${defaultTheme.dim(`... (${outputLines.length - 20} more lines)`)}`);
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

  complete(output: { success: boolean; summary: string; fullOutput?: string; duration: number }): void {
    this.state.status = output.success ? "completed" : "failed";
    this.state.outputSummary = output.summary;
    this.state.fullOutput = output.fullOutput;
    this.state.duration = output.duration;
  }

  abort(): void {
    this.state.status = "aborted";
  }

  toggleExpand(): void {
    this.state.expanded = !this.state.expanded;
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
    const dur = this.state.duration && this.state.duration > 100
      ? ` ${formatDuration(this.state.duration)}`
      : "";
    return `${iconColor(icon)} ${verb} ${target}${dur}`;
  }

  private getIcon(): string {
    switch (this.state.status) {
      case "pending": return defaultTheme.symbols.pending;
      case "running": return BRAILLE_SPINNER[this.spinnerFrame % BRAILLE_SPINNER.length]!;
      case "completed": return defaultTheme.symbols.success;
      case "failed": return defaultTheme.symbols.error;
      case "aborted": return "◼";
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
  if (ms < 1000) return defaultTheme.dim(`(${ms}ms)`);
  return defaultTheme.dim(`(${(ms / 1000).toFixed(1)}s)`);
}
