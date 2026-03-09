/**
 * Persist onboarding choices to .env and teamclaw.config.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RosterEntry = { role: string; count: number; description: string };

export interface PersistConfig {
  workerUrl: string;
  authToken: string;
  chatEndpoint?: string;
  model?: string;
  roster: RosterEntry[];
  workers?: Record<string, string>;
  goal: string;
}

export function writeConfig(cfg: PersistConfig): void {
  const cwd = process.cwd();
  const envPath = path.join(cwd, ".env");
  const configPath = path.join(cwd, "teamclaw.config.json");

  let envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  const setEnv = (key: string, val: string): void => {
    const value = val.trim();
    if (!value) return;
    const re = new RegExp(`^${key}=[^\\n]*`, "m");
    if (re.test(envContent)) {
      envContent = envContent.replace(re, `${key}=${value}`);
    } else {
      envContent = envContent.trimEnd();
      if (envContent && !envContent.endsWith("\n")) envContent += "\n";
      envContent += `${key}=${value}\n`;
    }
  };

  // OpenClaw connectivity
  setEnv("OPENCLAW_WORKER_URL", cfg.workerUrl);
  setEnv("OPENCLAW_TOKEN", cfg.authToken);
  setEnv("OPENCLAW_CHAT_ENDPOINT", cfg.chatEndpoint ?? "/v1/chat/completions");
  setEnv("OPENCLAW_MODEL", cfg.model ?? "");

  writeFileSync(envPath, envContent, "utf-8");

  const config: Record<string, unknown> = {
    roster: cfg.roster,
  };
  if (cfg.workers && Object.keys(cfg.workers).length > 0) {
    config.workers = cfg.workers;
  }
  if (cfg.goal) config.goal = cfg.goal;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
