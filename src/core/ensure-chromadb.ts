/**
 * Ensures ChromaDB is running. If unreachable, attempts to start it via docker compose.
 */

import { spawn } from "node:child_process";

function getChromaUrl(): string {
  const host = process.env.CHROMADB_HOST ?? "localhost";
  const port =
    process.env.CHROMADB_PORT ??
    (process.env.CHROMADB_HOST ? "8000" : "8020");
  return `http://${host}:${port}`;
}

async function chromaReachable(): Promise<boolean> {
  const url = getChromaUrl();
  try {
    const res = await fetch(`${url}/api/v1/heartbeat`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureChromaDB(
  onStart?: (msg: string) => void
): Promise<void> {
  const url = getChromaUrl();
  if (await chromaReachable()) return;

  const host = process.env.CHROMADB_HOST;
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    onStart?.("ChromaDB is configured for a remote host. Start it manually.");
    return;
  }

  onStart?.(`ChromaDB not reachable at ${url}. Attempting to start via docker compose...`);

  return new Promise((resolve) => {
    const openclawImageFallback = process.env["OPENCLAW_IMAGE"]?.trim()
      ? undefined
      : "openclaw/worker:latest";
    if (openclawImageFallback) {
      onStart?.("OPENCLAW_IMAGE not set. Injecting fallback for docker compose evaluation.");
    }
    const proc = spawn("docker", ["compose", "up", "-d", "chromadb"], {
      stdio: "pipe",
      cwd: process.cwd(),
      shell: true,
      env: {
        ...process.env,
        ...(openclawImageFallback ? { OPENCLAW_IMAGE: openclawImageFallback } : {}),
      },
    });

    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += String(d);
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        onStart?.(`docker compose up chromadb failed (code ${code}). ${stderr.slice(0, 200)}`);
        resolve();
        return;
      }
      onStart?.("ChromaDB container started. Waiting for readiness...");
      const startedAt = Date.now();
      const attempts = 30;
      const intervalMs = 2000;
      for (let i = 0; i < attempts; i++) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const verbose = ["true", "1", "yes"].includes((process.env["VERBOSE_LOGGING"] ?? "").toLowerCase());
        if (verbose && (i === 4 || i === 9 || i === 14 || i === 19 || i === 24)) {
          onStart?.(`Still waiting for ChromaDB heartbeat at ${url}... (${i + 1}/${attempts})`);
        }
        if (await chromaReachable()) {
          const elapsed = Date.now() - startedAt;
          onStart?.(`ChromaDB ready (elapsed ${elapsed}ms).`);
          resolve();
          return;
        }
      }
      const elapsed = Date.now() - startedAt;
      const waited = attempts * intervalMs;
      onStart?.(
        `ChromaDB did not become ready in time (waited ~${waited}ms, elapsed ${elapsed}ms). Using JSON fallback. ` +
          `Try: docker compose logs chromadb`,
      );
      resolve();
    });
  });
}
