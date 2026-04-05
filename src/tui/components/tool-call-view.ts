/**
 * ToolCallView — renders a single tool execution inline in the chat.
 * Shows spinner → result with collapsible output.
 */

import { defaultTheme, ctp } from "../themes/default.js";

export interface ToolCallViewState {
  executionId: string;
  toolName: string;
  toolDisplayName: string;
  agentId: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  inputSummary: string;
  progressMessage?: string;
  outputSummary?: string;
  fullOutput?: string;
  duration?: number;
  expanded: boolean;
}

// Tool name → verb + target extraction
const TOOL_VERBS: Record<string, string> = {
  file_read: "Read",
  file_write: "Wrote",
  file_edit: "Edited",
  file_list: "Listed",
  shell_exec: "Ran",
  execute_code: "Executed",
  git_ops: "Git",
  web_search: "Searched",
  web_fetch: "Fetched",
};

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

export class ToolCallView {
  private state: ToolCallViewState;
  private spinnerFrame = 0;

  constructor(init: Omit<ToolCallViewState, "expanded">) {
    this.state = { ...init, expanded: false };
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const { status, inputSummary, duration, expanded, fullOutput, outputSummary, progressMessage } = this.state;

    // Icon
    const icon = this.getIcon();
    const iconColor = this.getIconColor();

    // Verb + target
    const verb = this.getVerb();
    const target = inputSummary.slice(0, 40);
    const durationStr = duration && duration > 100 ? `  ${formatDuration(duration)}` : "";

    // Expand indicator
    const canExpand = !!fullOutput && fullOutput.split("\n").length > 1;
    const expandHint = canExpand
      ? (expanded ? "  ▾" : "  ▸")
      : "";

    // Main line
    const mainContent = `  ${iconColor(icon)} ${defaultTheme.bold(verb)}  ${defaultTheme.primary(target)}${durationStr}${expandHint}`;
    lines.push(mainContent);

    // Progress message (running state)
    if (status === "running" && progressMessage) {
      lines.push(`    ${defaultTheme.dim(progressMessage)}`);
    }

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
        // First 15 + ... + last 5
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
  get isInteractive(): boolean { return this.state.status === "pending"; }
  get executionId(): string { return this.state.executionId; }
  get status(): string { return this.state.status; }

  private getIcon(): string {
    switch (this.state.status) {
      case "pending": return defaultTheme.symbols.pending;
      case "running": return SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]!;
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
    if (this.state.status === "running") {
      const base = TOOL_VERBS[this.state.toolName] ?? this.state.toolDisplayName;
      // Add -ing suffix for running state
      if (base.endsWith("e")) return base.slice(0, -1) + "ing";
      if (base === "Read") return "Reading";
      if (base === "Ran") return "Running";
      if (base === "Git") return "Git";
      return base + "ing";
    }
    return TOOL_VERBS[this.state.toolName] ?? this.state.toolDisplayName;
  }
}

// ─── Helpers ─────────────────────────���───────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return defaultTheme.dim(`${ms}ms`);
  return defaultTheme.dim(`${(ms / 1000).toFixed(1)}s`);
}
