/**
 * Logs Command — View gateway, web dashboard, and work session logs.
 *
 * Usage:
 *   openpawl logs                  # Show all available log files
 *   openpawl logs gateway          # View gateway logs
 *   openpawl logs web              # View web dashboard logs
 *   openpawl logs work             # View work session logs
 *   openpawl logs gateway -f       # Follow (tail -f) gateway logs
 *   openpawl logs gateway -n 50    # Show last 50 lines
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { logger } from "../core/logger.js";
import pc from "picocolors";

interface LogSource {
  name: string;
  label: string;
  path: string;
  description: string;
}

function getLogSources(): LogSource[] {
  const homeDir = os.homedir();
  const cwd = process.cwd();

  return [
    {
      name: "gateway",
      label: "LLM Gateway",
      path: path.join(homeDir, ".openpawl", "gateway.log"),
      description: "Gateway process output (LLM routing, WebSocket protocol)",
    },
    {
      name: "web",
      label: "Web Dashboard",
      path: path.join(cwd, ".openpawl", "web.log"),
      description: "Fastify web server + WebSocket telemetry",
    },
    {
      name: "work",
      label: "Work Session",
      path: path.join(homeDir, ".openpawl", "logs"),
      description: "Work runner session history (per-session files in ~/.openpawl/logs/)",
    },
    {
      name: "debug",
      label: "Debug Logs",
      path: path.join(homeDir, ".openpawl", "debug"),
      description: "Structured debug logs (JSONL, enabled via OPENPAWL_DEBUG=true)",
    },
  ];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function printLogIndex(): void {
  const sources = getLogSources();

  logger.plain("");
  logger.plain(pc.bold("Available log files:"));
  logger.plain("");

  for (const src of sources) {
    const exists = existsSync(src.path);
    const status = exists ? pc.green("exists") : pc.dim("not found");
    let sizeInfo = "";
    if (exists) {
      try {
        const info = statSync(src.path);
        if (info.isDirectory()) {
          const count = readdirSync(src.path).filter((f) => f.endsWith(".log")).length;
          sizeInfo = pc.dim(` (${count} log file${count !== 1 ? "s" : ""})`);
        } else {
          sizeInfo = pc.dim(` (${formatSize(info.size)})`);
        }
      } catch {
        // ignore
      }
    }

    logger.plain(`  ${pc.bold(pc.cyan(src.name.padEnd(10)))} ${src.label}`);
    logger.plain(`  ${" ".repeat(10)} ${pc.dim(src.description)}`);
    logger.plain(`  ${" ".repeat(10)} ${pc.dim(src.path)} ${status}${sizeInfo}`);
    logger.plain("");
  }

  logger.plain(pc.dim("Usage:"));
  logger.plain(pc.dim("  openpawl logs <source>           View last 100 lines"));
  logger.plain(pc.dim("  openpawl logs <source> -f         Follow (live tail)"));
  logger.plain(pc.dim("  openpawl logs <source> -n <N>     Show last N lines"));
  logger.plain(pc.dim("  openpawl logs <source> --clear    Truncate log file"));
  logger.plain("");
}

function readLastLines(filePath: string, count: number): string[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  // Remove trailing empty line from final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-count);
}

function followLog(filePath: string): void {
  const child = spawn("tail", ["-f", "-n", "50", filePath], {
    stdio: "inherit",
  });

  process.on("SIGINT", () => {
    child.kill();
    process.exit(0);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

function findLatestLog(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".log"))
    .map((f) => ({ name: f, mtime: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

export async function runLogs(args: string[]): Promise<void> {
  const sourceName = args[0];

  // No args — show index
  if (!sourceName || sourceName === "--help" || sourceName === "-h") {
    printLogIndex();
    return;
  }

  // Debug logs have their own viewer with structured filtering
  if (sourceName === "debug") {
    const { runLogsDebug } = await import("./logs-debug.js");
    return runLogsDebug(args.slice(1));
  }

  const sources = getLogSources();
  const source = sources.find((s) => s.name === sourceName);

  if (!source) {
    logger.error(`Unknown log source: ${sourceName}`);
    logger.error(`Available: ${sources.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  // Resolve directory-based log sources to the latest file
  let resolvedPath = source.path;
  if (source.name === "work") {
    const latest = findLatestLog(source.path, "work-history-");
    if (!latest) {
      logger.warn(`No work history logs found in ${source.path}`);
      logger.plain(pc.dim("Run `openpawl work` to create a session log."));
      return;
    }
    resolvedPath = latest;
  } else if (!existsSync(resolvedPath)) {
    logger.warn(`Log file not found: ${resolvedPath}`);
    logger.plain(pc.dim("The gateway may not have been started yet. Run `openpawl work` to start a session."));
    return;
  }

  const flagArgs = args.slice(1);

  // --clear: truncate
  if (flagArgs.includes("--clear")) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resolvedPath, "");
    logger.success(`Cleared ${source.label} log: ${resolvedPath}`);
    return;
  }

  // -f: follow
  if (flagArgs.includes("-f") || flagArgs.includes("--follow")) {
    logger.plain(pc.dim(`Following ${source.label} log: ${resolvedPath}`));
    logger.plain(pc.dim("Press Ctrl+C to stop.\n"));
    followLog(resolvedPath);
    return;
  }

  // -n N: line count
  let lineCount = 100;
  const nIdx = flagArgs.indexOf("-n");
  if (nIdx !== -1 && flagArgs[nIdx + 1]) {
    lineCount = Math.max(1, parseInt(flagArgs[nIdx + 1], 10) || 100);
  }

  const lines = readLastLines(resolvedPath, lineCount);
  if (lines.length === 0) {
    logger.warn(`${source.label} log is empty.`);
    return;
  }

  logger.plain(pc.dim(`── ${source.label} (last ${lines.length} lines) ── ${resolvedPath}\n`));
  for (const line of lines) {
    logger.plain(line);
  }
  logger.plain(pc.dim(`\n── end (${lines.length} lines) ──`));
}
