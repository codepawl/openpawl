/**
 * CLI standup command — daily standup summary.
 */

import pc from "picocolors";
import { logger } from "../core/logger.js";

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)([dhw])$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const [, n, unit] = match;
  const num = Number(n);
  if (unit === "h") return num * 60 * 60 * 1000;
  if (unit === "d") return num * 24 * 60 * 60 * 1000;
  if (unit === "w") return num * 7 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function getMondayMidnight(): number {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
  const monday = new Date(now);
  monday.setDate(monday.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export async function runStandupCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    logger.plain([
      pc.bold("teamclaw standup") + " — Daily standup summary",
      "",
      "Usage:",
      "  teamclaw standup                   Today's standup (last 24h)",
      "  teamclaw standup --today           Since midnight",
      "  teamclaw standup --since 2d        Custom time window",
      "  teamclaw standup --week            Full current week",
      "  teamclaw standup --week-summary    Weekly recap",
      "  teamclaw standup --export          Output as markdown",
      "  teamclaw standup --export --out standup.md   Save to file",
    ].join("\n"));
    return;
  }

  const isExport = args.includes("--export");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const isWeekSummary = args.includes("--week-summary");

  if (outPath && !isExport) {
    logger.plain(pc.red("--out requires --export flag"));
    return;
  }

  // Handle weekly summary
  if (isWeekSummary) {
    const { collectWeeklySummary } = await import("../standup/collector.js");
    const { renderWeeklySummary } = await import("../standup/renderer.js");
    const summary = await collectWeeklySummary();
    logger.plain(renderWeeklySummary(summary));
    return;
  }

  // Determine time window
  let since: number;
  let label: string;

  if (args.includes("--today")) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    since = today.getTime();
    label = "today";
  } else if (args.includes("--week")) {
    since = getMondayMidnight();
    label = "this week";
  } else {
    const sinceIdx = args.indexOf("--since");
    const sinceValue = sinceIdx >= 0 ? args[sinceIdx + 1] ?? "24h" : "24h";
    const ms = parseDuration(sinceValue);
    since = Date.now() - ms;
    label = sinceValue;
  }

  const { collectStandupData } = await import("../standup/collector.js");
  const { generateSuggestions } = await import("../standup/suggester.js");
  const { renderStandup, exportMarkdown } = await import("../standup/renderer.js");

  const data = await collectStandupData({ since, label });

  // Generate suggestions
  data.suggested = generateSuggestions(data.blocked, data.yesterday.sessions);

  if (isExport) {
    const md = exportMarkdown(data);
    if (outPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outPath, md, "utf-8");
      logger.plain(pc.green(`Standup exported to ${outPath}`));
    } else {
      logger.plain(md);
    }
  } else {
    logger.plain(renderStandup(data));
  }
}
