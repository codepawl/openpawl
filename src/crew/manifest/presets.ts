/**
 * Built-in preset seeding.
 *
 * On first run, copy each built-in preset directory from the package's
 * presets/ tree into `~/.openpawl/crews/<name>/`. Already-installed
 * presets are left untouched so user edits survive upgrades.
 *
 * The preset source resolves from this module's directory at runtime so
 * both `tsx` (src tree) and the bundled CLI (dist tree, with presets
 * copied by the build script) work without configuration.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { debugLog } from "../../debug/logger.js";
import { userCrewDir, userCrewsDir } from "./loader.js";

export const FULL_STACK_PRESET = "full-stack";
export const BUILT_IN_PRESETS = [FULL_STACK_PRESET] as const;

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolve the directory containing built-in preset folders.
 *
 * - In the source tree (`src/crew/manifest/presets.ts`), this resolves to
 *   `src/crew/presets/`.
 * - In the bundled CLI (`dist/cli.js`), build copies the presets next to
 *   the bundle so `dist/presets/` exists. We probe both candidates and
 *   return the first that has the requested preset.
 */
export function builtInPresetsDir(): string {
  const here = moduleDir();
  const candidates = [
    path.resolve(here, "..", "presets"),
    path.resolve(here, "presets"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export function builtInPresetDir(name: string): string {
  return path.join(builtInPresetsDir(), name);
}

function copyDirRecursive(src: string, dest: string): number {
  let copied = 0;
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      copyFileSync(s, d);
      copied += 1;
    }
  }
  return copied;
}

export interface PresetSeedResult {
  installed: string[];
  skipped: string[];
  missing_source: string[];
}

export function ensureBuiltInPresets(homeDir: string = os.homedir()): PresetSeedResult {
  const installed: string[] = [];
  const skipped: string[] = [];
  const missingSource: string[] = [];

  const root = userCrewsDir(homeDir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  for (const name of BUILT_IN_PRESETS) {
    const src = builtInPresetDir(name);
    const dest = userCrewDir(name, homeDir);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      missingSource.push(name);
      continue;
    }
    if (existsSync(dest)) {
      skipped.push(name);
      continue;
    }
    const fileCount = copyDirRecursive(src, dest);
    debugLog("info", "crew", "preset_seeded", {
      data: { name, dest, file_count: fileCount },
    });
    installed.push(name);
  }
  return { installed, skipped, missing_source: missingSource };
}
