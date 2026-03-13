/**
 * Config manager: routes all keys to teamclaw.config.json.
 * 
 * Project-scoped settings like template, goal, creativity, max_cycles
 * are stored in teamclaw.config.json in the project directory.
 */

import {
  readTeamclawConfig,
  writeTeamclawConfig,
  getJsonKey,
  setJsonKey,
  unsetJsonKey,
} from "./jsonConfigManager.js";

export type ConfigSource = "teamclaw.config.json";

const DEFAULT_GOAL = "Build a small 2D game with sprite assets and sound effects";

export function getDefaultGoal(): string {
  const result = getConfigValue("default_goal", { raw: true });
  return result.value ?? DEFAULT_GOAL;
}

export type GetResult = {
  key: string;
  value: string | null;
  source: ConfigSource;
  masked: boolean;
};

export function isSecretKey(key: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(key);
}

function maskSecret(value: string): string {
  const v = value ?? "";
  if (v.length <= 8) return "********";
  const prefix = v.slice(0, 3);
  const suffix = v.slice(-4);
  return `${prefix}…${suffix}`;
}

function coerceJsonValue(key: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (key === "template" || key === "goal") {
    return { ok: true, value: raw };
  }
  if (key === "creativity") {
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0 || n > 1) return { ok: false, error: "creativity must be a number between 0 and 1" };
    return { ok: true, value: n };
  }
  if (key === "max_cycles") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: "max_cycles must be an integer >= 1" };
    return { ok: true, value: n };
  }
  return { ok: true, value: raw };
}

export function getConfigValue(
  key: string,
  options?: { raw?: boolean; cwd?: string },
): GetResult {
  const cwd = options?.cwd ?? process.cwd();
  const raw = options?.raw ?? false;

  const { data } = readTeamclawConfig(cwd);
  const v = getJsonKey(key, data);
  const str = v === undefined ? null : String(v);
  const shouldMask = !raw && str != null && isSecretKey(key);
  return { key, value: shouldMask && str != null ? maskSecret(str) : str, source: "teamclaw.config.json", masked: shouldMask };
}

export function setConfigValue(
  key: string,
  value: string,
  options?: { cwd?: string },
): { source: ConfigSource } | { error: string; source: ConfigSource } {
  const cwd = options?.cwd ?? process.cwd();

  const { path, data } = readTeamclawConfig(cwd);
  const coerced = coerceJsonValue(key, value);
  if (!coerced.ok) return { error: coerced.error, source: "teamclaw.config.json" };
  const next = setJsonKey(key, coerced.value, data);
  writeTeamclawConfig(path, next);
  return { source: "teamclaw.config.json" };
}

export function unsetConfigKey(
  key: string,
  options?: { cwd?: string },
): { source: ConfigSource } {
  const cwd = options?.cwd ?? process.cwd();

  const { path, data } = readTeamclawConfig(cwd);
  const next = unsetJsonKey(key, data);
  writeTeamclawConfig(path, next);
  return { source: "teamclaw.config.json" };
}
