/**
 * Manifest loader.
 *
 * Reads `manifest.yaml` from a crew directory, resolves each agent's
 * `prompt_file` (relative to the crew dir) into the inlined `prompt` field,
 * and validates the result against {@link CrewManifestSchema}.
 *
 * The loader does NOT apply cross-field business rules (constraint counts,
 * write_scope sanity, duplicate agent ids) — that lives in `validator.ts`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { debugLog } from "../../debug/logger.js";
import {
  CrewManifestSchema,
  RawCrewManifestSchema,
  type AgentDefinition,
  type CrewManifest,
} from "./types.js";

export const MANIFEST_FILENAME = "manifest.yaml";

export function userCrewsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".openpawl", "crews");
}

export function userCrewDir(name: string, homeDir: string = os.homedir()): string {
  return path.join(userCrewsDir(homeDir), name);
}

function resolvePromptFile(crewDir: string, promptFile: string): string {
  const abs = path.isAbsolute(promptFile)
    ? promptFile
    : path.join(crewDir, promptFile);
  if (!existsSync(abs)) {
    throw new Error(`prompt_file not found: ${abs}`);
  }
  const content = readFileSync(abs, "utf-8").trim();
  if (content.length < 10) {
    throw new Error(`prompt_file is shorter than 10 characters: ${abs}`);
  }
  return content;
}

export function loadManifestFromDir(crewDir: string): CrewManifest {
  const manifestPath = path.join(crewDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  const raw = YAML.parse(readFileSync(manifestPath, "utf-8"));
  const rawParsed = RawCrewManifestSchema.parse(raw);
  const agents: AgentDefinition[] = rawParsed.agents.map((a) => {
    const inlined =
      typeof a.prompt === "string" && a.prompt.trim().length >= 10
        ? a.prompt
        : resolvePromptFile(crewDir, a.prompt_file);
    return { ...a, prompt: inlined };
  });
  const manifest = CrewManifestSchema.parse({ ...rawParsed, agents });
  debugLog("info", "crew", "manifest_loaded", {
    data: {
      name: manifest.name,
      agent_count: manifest.agents.length,
      dir: crewDir,
    },
  });
  return manifest;
}

export function loadUserCrew(name: string, homeDir: string = os.homedir()): CrewManifest {
  return loadManifestFromDir(userCrewDir(name, homeDir));
}

export function listUserCrewNames(homeDir: string = os.homedir()): string[] {
  const dir = userCrewsDir(homeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
