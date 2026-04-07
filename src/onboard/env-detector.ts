/**
 * Environment detector — auto-detect providers, project, runtime.
 * All probes run concurrently. Must complete < 3s total.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectedEnvironment, ProjectType } from "./types.js";
import { detectProviders } from "../providers/detect.js";
import { maskCredential } from "../credentials/masking.js";

const PROBE_TIMEOUT_MS = 2000;

/**
 * Detect everything about the current environment.
 * All probes run in parallel — never blocks > 3s.
 */
export async function detectEnvironment(): Promise<DetectedEnvironment> {
  const cwd = process.cwd();

  // All probes run concurrently
  const [ollama, lmStudio, detected] = await Promise.all([
    probeOllama(),
    probeLMStudio(),
    detectProviders(),
  ]);

  const envKeys = detected
    .filter((d) => d.source === "env" && d.envKey)
    .map((d) => ({ provider: d.type, envVar: d.envKey!, masked: maskCredential(process.env[d.envKey!] ?? "") }));

  return {
    nodeVersion: process.version,
    packageManager: detectPackageManager(cwd),
    shell: process.env.SHELL ?? "unknown",
    terminal: process.env.TERM ?? "unknown",
    ollama,
    lmStudio,
    envKeys,
    project: detectProject(cwd),
    hasExistingConfig: checkExistingConfig(),
    existingConfigValid: checkExistingConfigValid(),
  };
}

// ─── Provider Probes ─────────────────────────────────────────────────────────

async function probeOllama(): Promise<DetectedEnvironment["ollama"]> {
  const url = "http://localhost:11434";
  try {
    const resp = await fetchWithTimeout(`${url}/api/tags`, PROBE_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = await resp.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    return { available: true, models, url };
  } catch {
    return null;
  }
}

async function probeLMStudio(): Promise<DetectedEnvironment["lmStudio"]> {
  const url = "http://localhost:1234";
  try {
    const resp = await fetchWithTimeout(`${url}/v1/models`, PROBE_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = await resp.json() as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id);
    return { available: true, models, url };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Mask API key: show first 6 + last 4, mask middle with dots. */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return key.slice(0, 6) + "•".repeat(Math.min(key.length - 10, 8)) + key.slice(-4);
}

// ─── Project Detection ───────────────────────────────────────────────────────

function detectProject(cwd: string): DetectedEnvironment["project"] {
  const result: DetectedEnvironment["project"] = {
    type: null,
    name: null,
    path: cwd,
    hasGit: existsSync(path.join(cwd, ".git")),
  };

  // Check manifest files in priority order
  const manifests: Array<[string, ProjectType, (content: string) => string | null]> = [
    ["package.json", "node", (c) => { try { return (JSON.parse(c) as { name?: string }).name ?? null; } catch { return null; } }],
    ["Cargo.toml", "rust", (c) => { const m = c.match(/name\s*=\s*"([^"]+)"/); return m?.[1] ?? null; }],
    ["pyproject.toml", "python", (c) => { const m = c.match(/name\s*=\s*"([^"]+)"/); return m?.[1] ?? null; }],
    ["go.mod", "go", (c) => { const m = c.match(/module\s+(\S+)/); return m?.[1]?.split("/").pop() ?? null; }],
    ["Gemfile", "ruby", () => null],
    ["pom.xml", "java", () => null],
    ["build.gradle", "java", () => null],
    ["requirements.txt", "python", () => null],
    ["setup.py", "python", () => null],
  ];

  for (const [file, type, extractName] of manifests) {
    const filePath = path.join(cwd, file);
    if (existsSync(filePath)) {
      result.type = type;
      try {
        const content = readFileSync(filePath, "utf-8");
        result.name = extractName(content);
      } catch {
        // Can't read — type is still set
      }
      break;
    }
  }

  return result;
}

// ─── Package Manager ─────────────────────────────────────────────────────────

function detectPackageManager(cwd: string): DetectedEnvironment["packageManager"] {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  return null;
}

// ─── Existing Config ─────────────────────────────────────────────────────────

function getConfigPath(): string {
  return path.join(os.homedir(), ".openpawl", "config.json");
}

function checkExistingConfig(): boolean {
  return existsSync(getConfigPath());
}

function checkExistingConfigValid(): boolean {
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}
