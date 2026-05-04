import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CREW_NAME,
  MIGRATION_MARKER,
  getGlobalConfigPath,
  getV03BackupPath,
  migrateV03ConfigIfNeeded,
} from "../config-migration.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), "openpawl-migration-"));
  mkdirSync(path.join(homeDir, ".openpawl"), { recursive: true });
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function writeConfig(home: string, payload: unknown): string {
  const p = getGlobalConfigPath(home);
  writeFileSync(p, JSON.stringify(payload, null, 2), "utf-8");
  return p;
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(getGlobalConfigPath(home), "utf-8"));
}

describe("migrateV03ConfigIfNeeded", () => {
  it("returns no_config_file when config does not exist", () => {
    const result = migrateV03ConfigIfNeeded(homeDir);
    expect(result.status).toBe("no_config_file");
  });

  it("returns no_legacy_fields when default_mode is absent", () => {
    writeConfig(homeDir, { version: 1, dashboardPort: 9001 });
    const result = migrateV03ConfigIfNeeded(homeDir);
    expect(result.status).toBe("no_legacy_fields");
    expect(existsSync(getV03BackupPath(homeDir))).toBe(false);
  });

  it("migrates default_mode=sprint with sprint_template to crew + crew_name", () => {
    writeConfig(homeDir, {
      version: 1,
      default_mode: "sprint",
      sprint_template: "full-stack",
      dashboardPort: 9001,
    });

    const result = migrateV03ConfigIfNeeded(homeDir);

    expect(result.status).toBe("migrated");
    expect(result.crewName).toBe("full-stack");

    const after = readConfig(homeDir);
    expect(after.default_mode).toBe("crew");
    expect(after.crew_name).toBe("full-stack");
    expect(after._migrated_from).toBe(MIGRATION_MARKER);
    expect(after.sprint_template).toBeUndefined();
    expect(after.dashboardPort).toBe(9001);
  });

  it("writes a v0.3 backup containing the original payload", () => {
    const original = {
      version: 1,
      default_mode: "sprint",
      sprint_template: "full-stack",
      providers: [{ type: "anthropic", apiKey: "sk-ant-test" }],
    };
    writeConfig(homeDir, original);

    migrateV03ConfigIfNeeded(homeDir);

    const backupPath = getV03BackupPath(homeDir);
    expect(existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
    expect(backup).toEqual(original);
  });

  it("falls back to default crew name when sprint_template missing", () => {
    writeConfig(homeDir, { version: 1, default_mode: "sprint" });
    const result = migrateV03ConfigIfNeeded(homeDir);
    expect(result.status).toBe("migrated");
    expect(result.crewName).toBe(DEFAULT_CREW_NAME);
    expect(readConfig(homeDir).crew_name).toBe(DEFAULT_CREW_NAME);
  });

  it("is idempotent — second run returns already_migrated and does not rewrite", () => {
    writeConfig(homeDir, {
      version: 1,
      default_mode: "sprint",
      sprint_template: "full-stack",
    });

    const first = migrateV03ConfigIfNeeded(homeDir);
    expect(first.status).toBe("migrated");

    const afterFirst = readFileSync(getGlobalConfigPath(homeDir), "utf-8");
    const backupAfterFirst = readFileSync(getV03BackupPath(homeDir), "utf-8");

    const second = migrateV03ConfigIfNeeded(homeDir);
    expect(second.status).toBe("already_migrated");
    expect(readFileSync(getGlobalConfigPath(homeDir), "utf-8")).toBe(afterFirst);
    expect(readFileSync(getV03BackupPath(homeDir), "utf-8")).toBe(backupAfterFirst);
  });

  it("preserves a pre-existing crew_name when migrating", () => {
    writeConfig(homeDir, {
      version: 1,
      default_mode: "sprint",
      crew_name: "my-team",
      sprint_template: "full-stack",
    });
    const result = migrateV03ConfigIfNeeded(homeDir);
    expect(result.crewName).toBe("my-team");
    expect(readConfig(homeDir).crew_name).toBe("my-team");
  });
});
