/**
 * Config manager: routes keys to `.env` or `teamclaw.config.json`.
 *
 * - `.env` is best for secrets and machine-specific values.
 * - `teamclaw.config.json` is best for project-scoped non-secret tuning.
 */

import { readEnvFile, writeEnvFile, getEnvValue, setEnvValue, unsetEnvKey } from "./envManager.js";
import {
  readTeamclawConfig,
  writeTeamclawConfig,
  getJsonKey,
  setJsonKey,
  unsetJsonKey,
} from "./jsonConfigManager.js";

export type ConfigSource = ".env" | "teamclaw.config.json";

export type GetResult = {
  key: string;
  value: string | null;
  source: ConfigSource;
  masked: boolean;
};

const JSON_KEYS = new Set(["template", "goal", "creativity", "max_cycles"]);

export function isSecretKey(key: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(key);
}

export function routesToJson(key: string): boolean {
  return JSON_KEYS.has(key);
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

  if (routesToJson(key)) {
    const { data } = readTeamclawConfig(cwd);
    const v = getJsonKey(key, data);
    const str = v === undefined ? null : String(v);
    const shouldMask = !raw && str != null && isSecretKey(key);
    return { key, value: shouldMask && str != null ? maskSecret(str) : str, source: "teamclaw.config.json", masked: shouldMask };
  }

  const env = readEnvFile(cwd);
  const v = getEnvValue(key, env.lines);
  const shouldMask = !raw && v != null && isSecretKey(key);
  return { key, value: shouldMask && v != null ? maskSecret(v) : v, source: ".env", masked: shouldMask };
}

export function setConfigValue(
  key: string,
  value: string,
  options?: { cwd?: string },
): { source: ConfigSource } | { error: string; source: ConfigSource } {
  const cwd = options?.cwd ?? process.cwd();

  if (routesToJson(key)) {
    const { path, data } = readTeamclawConfig(cwd);
    const coerced = coerceJsonValue(key, value);
    if (!coerced.ok) return { error: coerced.error, source: "teamclaw.config.json" };
    const next = setJsonKey(key, coerced.value, data);
    writeTeamclawConfig(path, next);
    return { source: "teamclaw.config.json" };
  }

  const env = readEnvFile(cwd);
  const nextLines = setEnvValue(key, value, env.lines);
  writeEnvFile(env.path, nextLines);
  return { source: ".env" };
}

export function unsetConfigKey(
  key: string,
  options?: { cwd?: string },
): { source: ConfigSource } {
  const cwd = options?.cwd ?? process.cwd();

  if (routesToJson(key)) {
    const { path, data } = readTeamclawConfig(cwd);
    const next = unsetJsonKey(key, data);
    writeTeamclawConfig(path, next);
    return { source: "teamclaw.config.json" };
  }

  const env = readEnvFile(cwd);
  const nextLines = unsetEnvKey(key, env.lines);
  writeEnvFile(env.path, nextLines);
  return { source: ".env" };
}

