/**
 * Persist onboarding choices to openpawl.config.json.
 */

import { writeFileSync } from "node:fs";
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
  templateId?: string;
  projectName?: string;
  teamMode?: "manual" | "autonomous";
}

export function writeConfig(cfg: PersistConfig): void {
  const cwd = process.cwd();
  const configPath = path.join(cwd, "openpawl.config.json");

  const config: Record<string, unknown> = {
    roster: cfg.roster,
    worker_url: cfg.workerUrl,     chat_endpoint: cfg.chatEndpoint ?? "/v1/chat/completions",   };
  if (cfg.model) config.model = cfg.model;   if (cfg.workers && Object.keys(cfg.workers).length > 0) {
    config.workers = cfg.workers;
  }
  if (cfg.goal) config.goal = cfg.goal;
  if (cfg.authToken) config.token = cfg.authToken;
  if (cfg.templateId) config.template = cfg.templateId;
  if (cfg.projectName) config.project_name = cfg.projectName;
  if (cfg.teamMode) config.team_mode = cfg.teamMode;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
