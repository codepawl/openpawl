#!/usr/bin/env tsx
/**
 * Profile comparison tool — parses two profile-report.md files and
 * outputs a side-by-side comparison table.
 *
 * Usage: bun run tsx src/testing/profile-compare.ts <baseline.md> <new.md>
 */

import { readFileSync } from "node:fs";

interface ProfileData {
  wallClock: number;
  llmTotal: number;
  llmCount: number;
  llmAvg: number;
  llmP95: number;
  toolTotal: number;
  memoryTotal: number;
  overhead: number;
  entries: Array<{ label: string; duration: number; meta?: string }>;
}

function parseMs(s: string): number {
  s = s.trim();
  if (s.endsWith("s") && !s.endsWith("ms")) {
    return parseFloat(s) * 1000;
  }
  if (s.endsWith("ms")) {
    return parseFloat(s);
  }
  return parseFloat(s);
}

function parseReport(content: string): ProfileData {
  const data: ProfileData = {
    wallClock: 0, llmTotal: 0, llmCount: 0, llmAvg: 0, llmP95: 0,
    toolTotal: 0, memoryTotal: 0, overhead: 0, entries: [],
  };

  // Parse "Total wall-clock: Xs"
  const wallMatch = content.match(/Total wall-clock:\s*([\d.]+s)/);
  if (wallMatch) data.wallClock = parseMs(wallMatch[1]!);

  // Parse "LLM calls: Xs (N%)"
  const llmMatch = content.match(/LLM calls:\s*([\d.]+[ms]*s?)/);
  if (llmMatch) data.llmTotal = parseMs(llmMatch[1]!);

  // Parse "Memory ops: Xms (N%)"
  const memMatch = content.match(/Memory ops:\s*([\d.]+[ms]*s?)/);
  if (memMatch) data.memoryTotal = parseMs(memMatch[1]!);

  // Parse "Tool execution: Xs (N%)"
  const toolMatch = content.match(/Tool execution:\s*([\d.]+[ms]*s?)/);
  if (toolMatch) data.toolTotal = parseMs(toolMatch[1]!);

  // Parse "Other overhead: Xs"
  const overMatch = content.match(/Other overhead:\s*([\d.]+[ms]*s?)/);
  if (overMatch) data.overhead = parseMs(overMatch[1]!);

  // Parse category table for llm_call_total row
  const tableLines = content.split("\n");
  for (const line of tableLines) {
    if (line.includes("llm_call_total")) {
      const parts = line.split("|").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 5) {
        data.llmCount = parseInt(parts[1]!) || 0;
        data.llmAvg = parseMs(parts[2]!);
        data.llmP95 = parseMs(parts[3]!);
      }
    }
  }

  // Parse raw entries
  const rawSection = content.indexOf("## Raw Entries");
  if (rawSection >= 0) {
    const rawLines = content.slice(rawSection).split("\n");
    for (const line of rawLines) {
      const entryMatch = line.match(/\[([^\]]+)\]\s+(\S+)\s+(\S+.*?)\s{2,}([\d.]+[ms]*s?)/);
      if (entryMatch) {
        data.entries.push({
          label: entryMatch[3]!.trim(),
          duration: parseMs(entryMatch[4]!),
          meta: undefined,
        });
      }
    }
  }

  return data;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function delta(before: number, after: number): string {
  const diff = after - before;
  const pct = before > 0 ? ((diff / before) * 100).toFixed(0) : "n/a";
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${formatMs(diff)} (${sign}${pct}%)`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: bun run tsx src/testing/profile-compare.ts <baseline.md> <new.md>");
    process.exit(1);
  }

  const baselineContent = readFileSync(args[0]!, "utf-8");
  const newContent = readFileSync(args[1]!, "utf-8");

  const baseline = parseReport(baselineContent);
  const current = parseReport(newContent);

  console.log("# Performance Comparison\n");

  // Summary table
  const rows: Array<[string, string, string, string]> = [
    ["Total wall-clock",  formatMs(baseline.wallClock),  formatMs(current.wallClock),  delta(baseline.wallClock, current.wallClock)],
    ["LLM calls count",   String(baseline.llmCount),     String(current.llmCount),     `${current.llmCount - baseline.llmCount >= 0 ? "+" : ""}${current.llmCount - baseline.llmCount}`],
    ["LLM total time",    formatMs(baseline.llmTotal),    formatMs(current.llmTotal),    delta(baseline.llmTotal, current.llmTotal)],
    ["LLM avg per call",  formatMs(baseline.llmAvg),      formatMs(current.llmAvg),      delta(baseline.llmAvg, current.llmAvg)],
    ["LLM P95",           formatMs(baseline.llmP95),       formatMs(current.llmP95),       delta(baseline.llmP95, current.llmP95)],
    ["Tool exec total",   formatMs(baseline.toolTotal),    formatMs(current.toolTotal),    delta(baseline.toolTotal, current.toolTotal)],
    ["Memory ops",        formatMs(baseline.memoryTotal),   formatMs(current.memoryTotal),   delta(baseline.memoryTotal, current.memoryTotal)],
    ["Overhead",          formatMs(baseline.overhead),      formatMs(current.overhead),      delta(baseline.overhead, current.overhead)],
  ];

  // Calculate column widths
  const headers = ["Metric", "Baseline", "After", "Delta"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const fmtRow = (cells: string[]) =>
    "| " + cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ") + " |";

  console.log(fmtRow(headers));
  console.log(sep);
  for (const row of rows) {
    console.log(fmtRow(row));
  }

  // LLM call details
  const llmEntries = (data: ProfileData) =>
    data.entries.filter((e) => e.label === "callLLM" || e.label === "callLLMWithMessages");

  const baselineLLM = llmEntries(baseline);
  const currentLLM = llmEntries(current);

  if (baselineLLM.length > 0 || currentLLM.length > 0) {
    console.log("\n## Per-Call Breakdown\n");
    console.log("### Baseline");
    for (let i = 0; i < baselineLLM.length; i++) {
      console.log(`  Call ${i + 1}: ${formatMs(baselineLLM[i]!.duration)}`);
    }
    console.log("\n### After");
    for (let i = 0; i < currentLLM.length; i++) {
      console.log(`  Call ${i + 1}: ${formatMs(currentLLM[i]!.duration)}`);
    }
  }

  // Context growth check
  if (baselineLLM.length >= 2) {
    const first = baselineLLM[0]!.duration;
    const last = baselineLLM[baselineLLM.length - 1]!.duration;
    const ratio = last / first;
    console.log(`\n## Context Growth (Baseline): ${formatMs(first)} → ${formatMs(last)} (${ratio.toFixed(1)}x)`);
  }
  if (currentLLM.length >= 2) {
    const first = currentLLM[0]!.duration;
    const last = currentLLM[currentLLM.length - 1]!.duration;
    const ratio = last / first;
    console.log(`## Context Growth (After): ${formatMs(first)} → ${formatMs(last)} (${ratio.toFixed(1)}x)`);
  }
}

main();
