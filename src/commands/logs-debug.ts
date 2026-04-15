/**
 * Debug Log Viewer — reads and filters JSONL debug logs.
 *
 * Usage:
 *   openpawl logs debug                        # Latest session, last 50 entries
 *   openpawl logs debug --session latest        # Explicit latest
 *   openpawl logs debug --level error           # Filter by level
 *   openpawl logs debug --source sprint         # Filter by source
 *   openpawl logs debug --event task:start      # Filter by event substring
 *   openpawl logs debug --grep "file_write"     # Search across all fields
 *   openpawl logs debug --tail 100              # Show last 100 entries
 *   openpawl logs debug -f                      # Follow (live tail)
 *   openpawl logs debug --json                  # Raw JSONL output
 *   openpawl logs debug --timeline              # Compact chronological view
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import pc from "picocolors";
import { logger } from "../core/logger.js";
import type { DebugLog, DebugLevel } from "../debug/logger.js";

// ── Helpers ────────────────────────────────────────────────────────────

const DEBUG_DIR = join(homedir(), ".openpawl", "debug");

const LEVEL_ORDER: Record<DebugLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<DebugLevel, (s: string) => string> = {
  debug: pc.dim,
  info: pc.cyan,
  warn: pc.yellow,
  error: pc.red,
};

function resolveLogFile(sessionArg: string | null): string | null {
  if (!existsSync(DEBUG_DIR)) return null;

  if (!sessionArg || sessionArg === "latest") {
    const files = readdirSync(DEBUG_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(join(DEBUG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? join(DEBUG_DIR, files[0]!.name) : null;
  }

  // Try exact match
  const exact = join(DEBUG_DIR, sessionArg.endsWith(".jsonl") ? sessionArg : `${sessionArg}.jsonl`);
  if (existsSync(exact)) return exact;

  // Try prefix match
  const files = readdirSync(DEBUG_DIR).filter((f) => f.startsWith(sessionArg) && f.endsWith(".jsonl"));
  if (files.length > 0) return join(DEBUG_DIR, files[0]!);

  return null;
}

function parseEntry(line: string): DebugLog | null {
  try {
    return JSON.parse(line) as DebugLog;
  } catch {
    return null;
  }
}

function matchesFilters(
  entry: DebugLog,
  filters: { level: DebugLevel | null; source: string | null; event: string | null; grep: string | null },
): boolean {
  if (filters.level && LEVEL_ORDER[entry.level] < LEVEL_ORDER[filters.level]) {
    return false;
  }
  if (filters.source && entry.source !== filters.source) {
    return false;
  }
  if (filters.event && !entry.event.includes(filters.event)) {
    return false;
  }
  if (filters.grep) {
    const s = JSON.stringify(entry).toLowerCase();
    if (!s.includes(filters.grep.toLowerCase())) return false;
  }
  return true;
}

function formatEntry(entry: DebugLog): string {
  const time = entry.timestamp.split("T")[1]?.split("Z")[0] ?? entry.timestamp;
  const levelStr = entry.level.padEnd(5);
  const sourceStr = entry.source.padEnd(7);
  const eventStr = entry.event.padEnd(28);
  const colorLevel = LEVEL_COLORS[entry.level] ?? pc.dim;

  let detail = "";
  if (entry.error) {
    detail = pc.red(` ${entry.error}`);
  } else if (entry.data) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(entry.data)) {
      if (typeof v === "string") parts.push(`${k}="${v.slice(0, 60)}"`);
      else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
    }
    if (parts.length > 0) detail = pc.dim(` ${parts.join(" ")}`);
  }

  const durationStr = entry.duration !== undefined ? pc.dim(` (${formatMs(entry.duration)})`) : "";

  return `${pc.dim(time)} ${colorLevel(`[${levelStr}]`)} ${pc.blue(`[${sourceStr}]`)} ${eventStr}${durationStr}${detail}`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** Compact timeline view */
function formatTimeline(entry: DebugLog): string {
  const time = (entry.timestamp.split("T")[1] ?? "").split(".")[0] ?? "";
  const src = entry.source.padEnd(7);
  const colorLevel = LEVEL_COLORS[entry.level] ?? pc.dim;

  // Build a compact one-liner
  const parts: string[] = [];

  // Extract key-value pairs from data
  if (entry.data) {
    for (const [k, v] of Object.entries(entry.data)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.length > 60) {
        parts.push(`${k}="${v.slice(0, 57)}..."`);
      } else if (typeof v === "string") {
        parts.push(`${k}="${v}"`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${v}`);
      }
    }
  }

  const durationStr = entry.duration !== undefined ? ` ${formatMs(entry.duration)}` : "";
  const errorStr = entry.error ? ` ${pc.red("ERROR: " + entry.error.slice(0, 60))}` : "";
  const dataStr = parts.length > 0 ? ` ${parts.join(" ")}` : "";

  return `  ${pc.dim(time)} ${colorLevel(`[${src}]`)} ${entry.event}${durationStr}${dataStr}${errorStr}`;
}

// ── Parse flags ────────────────────────────────────────────────────────

interface DebugLogFlags {
  session: string | null;
  level: DebugLevel | null;
  source: string | null;
  event: string | null;
  grep: string | null;
  tail: number;
  follow: boolean;
  json: boolean;
  timeline: boolean;
}

function parseFlags(args: string[]): DebugLogFlags {
  const flags: DebugLogFlags = {
    session: null,
    level: null,
    source: null,
    event: null,
    grep: null,
    tail: 50,
    follow: false,
    json: false,
    timeline: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case "--session":
        flags.session = next ?? null;
        i++;
        break;
      case "--level":
        if (next && next in LEVEL_ORDER) {
          flags.level = next as DebugLevel;
        }
        i++;
        break;
      case "--source":
        flags.source = next ?? null;
        i++;
        break;
      case "--event":
        flags.event = next ?? null;
        i++;
        break;
      case "--grep":
        flags.grep = next ?? null;
        i++;
        break;
      case "--tail":
      case "-n":
        flags.tail = Math.max(1, parseInt(next ?? "50", 10) || 50);
        i++;
        break;
      case "-f":
      case "--follow":
        flags.follow = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--timeline":
        flags.timeline = true;
        break;
    }
  }

  return flags;
}

// ── Main ───────────────────────────────────────────────────────────────

export async function runLogsDebug(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  // List available sessions if no debug dir exists
  if (!existsSync(DEBUG_DIR)) {
    logger.warn("No debug logs found.");
    logger.plain(pc.dim("Enable debug logging: OPENPAWL_DEBUG=true openpawl run --headless ..."));
    return;
  }

  const logFile = resolveLogFile(flags.session);
  if (!logFile) {
    logger.warn("No matching debug log file found.");
    const files = readdirSync(DEBUG_DIR).filter((f) => f.endsWith(".jsonl"));
    if (files.length > 0) {
      logger.plain(pc.dim("\nAvailable sessions:"));
      for (const f of files.slice(0, 10)) {
        const stat = statSync(join(DEBUG_DIR, f));
        logger.plain(`  ${pc.cyan(f.replace(".jsonl", ""))} ${pc.dim(`(${formatBytes(stat.size)})`)}`);
      }
    }
    return;
  }

  // Follow mode: use tail -f with parsed JSONL rendering
  if (flags.follow) {
    logger.plain(pc.dim(`Following: ${logFile}`));
    logger.plain(pc.dim("Press Ctrl+C to stop.\n"));
    const child = spawn("tail", ["-f", "-n", String(flags.tail), logFile], {
      stdio: flags.json ? "inherit" : ["ignore", "pipe", "inherit"],
    });

    if (!flags.json && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const entry = parseEntry(line);
          if (!entry) continue;
          if (matchesFilters(entry, flags)) {
            const formatter = flags.timeline ? formatTimeline : formatEntry;
            process.stdout.write(formatter(entry) + "\n");
          }
        }
      });
    }

    process.on("SIGINT", () => {
      child.kill();
      process.exit(0);
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  // Read and filter
  const content = readFileSync(logFile, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: DebugLog[] = [];

  for (const line of lines) {
    const entry = parseEntry(line);
    if (entry && matchesFilters(entry, flags)) {
      entries.push(entry);
    }
  }

  // Take last N
  const shown = entries.slice(-flags.tail);

  if (shown.length === 0) {
    logger.warn("No entries match the filters.");
    logger.plain(pc.dim(`File: ${logFile} (${lines.length} total entries)`));
    return;
  }

  const sessionName = logFile.split("/").pop()?.replace(".jsonl", "") ?? "";
  logger.plain(pc.dim(`── Debug Log: ${sessionName} (${shown.length}/${entries.length} entries) ──\n`));

  const formatter = flags.timeline ? formatTimeline : flags.json ? null : formatEntry;

  for (const entry of shown) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(entry) + "\n");
    } else {
      process.stdout.write(formatter!(entry) + "\n");
    }
  }

  if (!flags.json) {
    logger.plain(pc.dim(`\n── end (${shown.length} entries) ── ${logFile}`));
  }
}
