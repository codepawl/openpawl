/**
 * Background service manager for Web UI.
 * Persists PIDs to .teamclaw/daemon.json and logs to .teamclaw/web.log.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DAEMON_DIR = ".teamclaw";
const STATE_FILE = "daemon.json";
const WEB_LOG = "web.log";
const DEFAULT_WEB_PORT = 9001;

export interface DaemonState {
  web?: { pid: number; port: number; startedAt?: string };
}

function getDaemonDir(): string {
  return path.join(process.cwd(), DAEMON_DIR);
}

function getStatePath(): string {
  return path.join(getDaemonDir(), STATE_FILE);
}

function ensureDaemonDir(): void {
  const dir = getDaemonDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readState(): DaemonState | null {
  const p = getStatePath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

function writeState(state: DaemonState): void {
  ensureDaemonDir();
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StartOptions {
  web?: boolean;
  gateway?: boolean;
  webPort?: number;
}

export function start(options: StartOptions): { started: string[]; error?: string } {
  const state = readState();
  const webPid = state?.web?.pid;
  if (webPid != null && isPidAlive(webPid)) {
    return { started: [], error: "Services already running (use teamclaw stop first)." };
  }

  const cliPath = process.argv[1];
  if (!cliPath) {
    return { started: [], error: "Cannot resolve CLI path." };
  }

  const started: string[] = [];
  const newState: DaemonState = {};

  if (options.web === true) {
    const port = options.webPort ?? (Number(process.env["WEB_PORT"]) || DEFAULT_WEB_PORT);
    const logPath = path.join(getDaemonDir(), WEB_LOG);
    ensureDaemonDir();
    const logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, [cliPath, "web", "-p", String(port)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production" },
    });
    child.unref();
    try {
      closeSync(logFd);
    } catch {
      // ignore
    }
    newState.web = { pid: child.pid!, port, startedAt: new Date().toISOString() };
    started.push("web");
  }

  if (Object.keys(newState).length > 0) {
    const merged = { ...readState(), ...newState };
    writeState(merged);
  }

  return { started };
}

export function stop(): void {
  const state = readState();
  if (!state) return;
  if (state.web?.pid != null) {
    try {
      process.kill(state.web.pid, "SIGTERM");
    } catch {
      // process already gone
    }
  }
  const p = getStatePath();
  if (existsSync(p)) {
    rmSync(p, { force: true });
  }
}

export interface StatusResult {
  web: "running" | "stopped";
  gateway: "running" | "stopped";
  webPort?: number;
}

export function status(): StatusResult {
  const state = readState();
  const result: StatusResult = {
    web: "stopped",
    gateway: "stopped",
  };
  if (state?.web != null) {
    result.web = isPidAlive(state.web.pid) ? "running" : "stopped";
    result.webPort = state.web.port;
  }
  return result;
}
