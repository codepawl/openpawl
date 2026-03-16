/**
 * Persistent storage for registered custom agents.
 * Registry lives at ~/.teamclaw/agents/registry.json.
 * Compiled agent modules stored at ~/.teamclaw/agents/custom/<role>.mjs.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ValidatedAgentDef } from "./validator.js";

const AGENTS_DIR = path.join(os.homedir(), ".teamclaw", "agents");
const CUSTOM_DIR = path.join(AGENTS_DIR, "custom");
const REGISTRY_FILE = path.join(AGENTS_DIR, "registry.json");

export interface RegisteredAgent {
  role: string;
  displayName: string;
  description: string;
  source: string;
  compiledPath: string;
  registeredAt: string;
}

interface RegistryData {
  agents: RegisteredAgent[];
}

function ensureDirs(): void {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(CUSTOM_DIR, { recursive: true });
}

function readRegistry(): RegistryData {
  if (!existsSync(REGISTRY_FILE)) {
    return { agents: [] };
  }
  const raw = readFileSync(REGISTRY_FILE, "utf-8");
  return JSON.parse(raw) as RegistryData;
}

function writeRegistry(data: RegistryData): void {
  ensureDirs();
  writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export class AgentRegistryStore {
  /** Register a validated agent definition. Copies compiled module to persistent storage. */
  async register(def: ValidatedAgentDef, sourcePath: string): Promise<RegisteredAgent> {
    ensureDirs();
    const compiledPath = path.join(CUSTOM_DIR, `${def.role}.mjs`);

    // Compile if TypeScript, otherwise copy
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext === ".ts") {
      const esbuildModule = "esbuild";
      const esbuild = await import(/* webpackIgnore: true */ esbuildModule) as { transform: (code: string, opts: Record<string, unknown>) => Promise<{ code: string }> };
      const source = await readFile(sourcePath, "utf-8");
      const result = await esbuild.transform(source, {
        loader: "ts",
        format: "esm",
        target: "node20",
      });
      await writeFile(compiledPath, result.code, "utf-8");
    } else {
      await copyFile(sourcePath, compiledPath);
    }

    // Also store the definition JSON for sync loading
    const defPath = path.join(CUSTOM_DIR, `${def.role}.json`);
    const defData = { ...def };
    // Strip hooks from JSON — they can't be serialized
    delete (defData as Record<string, unknown>).hooks;
    delete (defData as Record<string, unknown>).__teamclaw_agent;
    await writeFile(defPath, JSON.stringify(defData, null, 2), "utf-8");

    const entry: RegisteredAgent = {
      role: def.role,
      displayName: def.displayName,
      description: def.description,
      source: sourcePath,
      compiledPath,
      registeredAt: new Date().toISOString(),
    };

    const registry = readRegistry();
    const idx = registry.agents.findIndex((a) => a.role === def.role);
    if (idx >= 0) {
      registry.agents[idx] = entry;
    } else {
      registry.agents.push(entry);
    }
    writeRegistry(registry);
    return entry;
  }

  /** Remove a registered agent. */
  unregister(role: string): boolean {
    const registry = readRegistry();
    const idx = registry.agents.findIndex((a) => a.role === role);
    if (idx < 0) return false;

    const agent = registry.agents[idx];
    // Remove compiled file
    if (agent.compiledPath && existsSync(agent.compiledPath)) {
      unlinkSync(agent.compiledPath);
    }
    // Remove definition JSON
    const defPath = path.join(CUSTOM_DIR, `${role}.json`);
    if (existsSync(defPath)) {
      unlinkSync(defPath);
    }

    registry.agents.splice(idx, 1);
    writeRegistry(registry);
    return true;
  }

  /** List all registered agents. */
  list(): RegisteredAgent[] {
    return readRegistry().agents;
  }

  /** Get a specific registered agent by role. */
  get(role: string): RegisteredAgent | null {
    const registry = readRegistry();
    return registry.agents.find((a) => a.role === role) ?? null;
  }

  /**
   * Load all agent definitions synchronously from stored JSON files.
   * Hooks are not available in sync mode — use loadAllAsync() for full definitions.
   */
  loadAllSync(): ValidatedAgentDef[] {
    const registry = readRegistry();
    const defs: ValidatedAgentDef[] = [];

    for (const agent of registry.agents) {
      const defPath = path.join(CUSTOM_DIR, `${agent.role}.json`);
      if (!existsSync(defPath)) continue;
      try {
        const raw = readFileSync(defPath, "utf-8");
        const def = JSON.parse(raw) as ValidatedAgentDef;
        defs.push(def);
      } catch {
        // Skip malformed definitions
      }
    }

    return defs;
  }

  /** Load all definitions asynchronously, including hooks from compiled modules. */
  async loadAllAsync(): Promise<ValidatedAgentDef[]> {
    const registry = readRegistry();
    const defs: ValidatedAgentDef[] = [];

    for (const agent of registry.agents) {
      if (agent.compiledPath && existsSync(agent.compiledPath)) {
        try {
          const { pathToFileURL } = await import("node:url");
          const mod = await import(pathToFileURL(agent.compiledPath).href);
          const def = mod.default ?? mod.agent;
          if (def) defs.push(def);
        } catch {
          // Fall back to JSON
          const defPath = path.join(CUSTOM_DIR, `${agent.role}.json`);
          if (existsSync(defPath)) {
            const raw = readFileSync(defPath, "utf-8");
            defs.push(JSON.parse(raw) as ValidatedAgentDef);
          }
        }
      }
    }

    return defs;
  }
}
