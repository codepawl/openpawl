/**
 * v0.3 → v0.4 config migration (spec §7.5).
 *
 * Detects legacy `default_mode: "sprint"` (and the `sprint_template` field) in
 * the user's global config, backs the original up to
 * `~/.openpawl/config.v0.3.bak.json`, and rewrites the config to the v0.4
 * shape. Idempotent: gated by the `_migrated_from` field.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MIGRATION_MARKER = "v0.3";
export const DEFAULT_CREW_NAME = "full-stack";

export function getGlobalConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".openpawl", "config.json");
}

export function getV03BackupPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".openpawl", "config.v0.3.bak.json");
}

export interface MigrationResult {
  status: "migrated" | "already_migrated" | "no_legacy_fields" | "no_config_file";
  configPath: string;
  backupPath?: string;
  crewName?: string;
}

interface LegacyConfigShape {
  default_mode?: string;
  sprint_template?: string;
  crew_name?: string;
  _migrated_from?: string;
  [key: string]: unknown;
}

function readRawConfig(configPath: string): LegacyConfigShape | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as LegacyConfigShape;
  } catch {
    return null;
  }
}

export function migrateV03ConfigIfNeeded(homeDir: string = os.homedir()): MigrationResult {
  const configPath = getGlobalConfigPath(homeDir);
  const config = readRawConfig(configPath);

  if (!config) {
    return { status: "no_config_file", configPath };
  }

  if (config._migrated_from === MIGRATION_MARKER) {
    return { status: "already_migrated", configPath };
  }

  if (config.default_mode !== "sprint") {
    return { status: "no_legacy_fields", configPath };
  }

  const backupPath = getV03BackupPath(homeDir);
  writeFileSync(backupPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const crewName =
    typeof config.crew_name === "string" && config.crew_name.trim()
      ? config.crew_name.trim()
      : typeof config.sprint_template === "string" && config.sprint_template.trim()
        ? config.sprint_template.trim()
        : DEFAULT_CREW_NAME;

  const { sprint_template: _drop, ...rest } = config;
  void _drop;
  const migrated: LegacyConfigShape = {
    ...rest,
    default_mode: "crew",
    crew_name: crewName,
    _migrated_from: MIGRATION_MARKER,
  };

  writeFileSync(configPath, JSON.stringify(migrated, null, 2) + "\n", "utf-8");

  return { status: "migrated", configPath, backupPath, crewName };
}
