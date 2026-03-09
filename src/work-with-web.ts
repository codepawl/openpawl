/**
 * Runs a work session via the web server, so the dashboard shows live progress.
 * Starts the web server if not already running, connects via WebSocket, triggers run.
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import { loadTeamConfig } from "./core/team-config.js";
import { logger } from "./core/logger.js";

const DEFAULT_GOAL = "Build a small 2D game with sprite assets and sound effects";
const DEFAULT_PORT = 8000;

async function waitForHttp(baseUrl: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 304) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(500),
    });
    return false;
  } catch {
    return true;
  }
}

function waitForWebSocket(url: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timeout"));
    }, timeoutMs);
    ws.on("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.on("error", () => {
      clearTimeout(t);
      reject(new Error("WebSocket connection failed"));
    });
  });
}

async function runViaWeb(port: number, goalOverride?: string): Promise<number> {
  const baseUrl = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}/ws`;

  const teamConfig = await loadTeamConfig();
  const goal = goalOverride?.trim() || teamConfig?.goal?.trim() || DEFAULT_GOAL;
  const teamTemplate = teamConfig?.template ?? "game_dev";

  const ws = await waitForWebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Session did not complete in time"));
    }, 600_000);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        const type = msg.type as string | undefined;
        if (type === "session_complete") {
          clearTimeout(timeout);
          ws.close();
          logger.success("Work session complete. Dashboard remains at " + baseUrl);
          resolve(0);
        } else if (type === "error") {
          logger.error(String(msg.message ?? "Unknown error"));
        } else if (type === "generation_start") {
          const gen = msg.generation as number;
          const max = msg.max_generations as number;
          const lessons = (msg.lessons_count as number) ?? 0;
          logger.info(`Generation ${gen}/${max} starting (${lessons} lessons loaded)`);
        } else if (type === "generation_end") {
          const gen = msg.generation as number;
          const outcome = msg.outcome as string;
          const fs = (msg.final_state ?? {}) as Record<string, unknown>;
          const done = (fs.tasks_completed as number) ?? 0;
          const failed = (fs.tasks_failed as number) ?? 0;
          const cycles = (fs.cycles_survived as number) ?? 0;
          logger.info(`Generation ${gen} complete (${outcome}) — ${cycles} cycles, ${done} tasks done, ${failed} failed`);
        } else if (type === "cycle_start") {
          const cycle = msg.cycle as number;
          const max = msg.max_cycles as number;
          logger.info(`Cycle ${cycle}/${max}`);
        } else if (type === "node_event") {
          const node = msg.node as string;
          const d = (msg.data ?? {}) as Record<string, unknown>;
          if (node === "coordinator") {
            const pending = (d.pending_count as number) ?? 0;
            logger.info(`Coordinator: ${pending} tasks pending`);
          } else if (node === "worker_execute") {
            const success = d.success as boolean;
            const desc = (d.description as string)?.slice(0, 60) ?? "task";
            const icon = success ? "✓" : "✗";
            logger.info(`${icon} ${desc}${(desc?.length ?? 0) >= 60 ? "…" : ""}`);
          }
        } else if (type === "provision_error") {
          logger.error(String(msg.error ?? "❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function."));
          process.exit(1);
        } else if (type === "session_cancelled") {
          logger.info("Session cancelled.");
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      resolve(0);
    });

    ws.send(
      JSON.stringify({
        command: "start",
        user_goal: goal,
        team_template: teamTemplate,
      })
    );
    ws.send(JSON.stringify({ command: "resume" }));
    logger.info(`Work session started. View live at ${baseUrl}`);
    logger.info(`Goal: ${goal}`);
  });
}

export async function runWorkWithWeb(args: string[]): Promise<void> {
  let port = DEFAULT_PORT;
  let spawnWeb = true;
  let goalOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[i + 1], 10) || DEFAULT_PORT;
      i++;
    } else if ((args[i] === "--goal" || args[i] === "-g") && args[i + 1]) {
      goalOverride = String(args[i + 1]);
      i++;
    } else if ((args[i] ?? "").startsWith("--goal=")) {
      goalOverride = String(args[i]).slice("--goal=".length);
    } else if (args[i] === "--no-start") {
      spawnWeb = false;
    }
  }

  const baseUrl = `http://localhost:${port}`;

  let serverProc: ReturnType<typeof spawn> | null = null;

  const killSpawnedServer = (): void => {
    if (serverProc?.pid) {
      try {
        process.kill(-serverProc.pid, "SIGTERM");
      } catch {
        try {
          serverProc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      serverProc = null;
    }
  };

  const onExit = (signal: string): void => {
    killSpawnedServer();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => onExit("SIGINT"));
  process.on("SIGTERM", () => onExit("SIGTERM"));

  if (spawnWeb) {
    let spawnPort = port;
    const defaultUp = await waitForHttp(baseUrl, 3);
    if (defaultUp) {
      for (let p = port + 1; p < port + 10; p++) {
        if (await isPortFree(p)) {
          spawnPort = p;
          break;
        }
      }
      if (spawnPort === port) {
        logger.error("Default port busy and no free port found. Stop the existing server and try again.");
        process.exit(1);
      }
    }
    const spawnUrl = `http://localhost:${spawnPort}`;
    const spawnUp = await waitForHttp(spawnUrl, 2);
    if (!spawnUp) {
      logger.info("Starting web server...");
      serverProc = spawn(
        process.execPath,
        [process.argv[1], "web", "-p", String(spawnPort)],
        {
          stdio: "ignore",
          env: { ...process.env, NODE_ENV: "production" },
          cwd: process.cwd(),
          detached: true,
        }
      );
      serverProc.unref();
      serverProc.on("error", (err) => {
        logger.error("Failed to start web server: " + String(err));
        process.exit(1);
      });
      const ready = await waitForHttp(spawnUrl, 40);
      if (!ready) {
        logger.error("Web server did not become ready in time.");
        serverProc.kill();
        process.exit(1);
      }
      port = spawnPort;
    }
  }

  try {
    await runViaWeb(port, goalOverride);
  } catch (err) {
    logger.error(String(err));
    killSpawnedServer();
    process.exit(1);
  }
}
