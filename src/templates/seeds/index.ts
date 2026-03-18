/**
 * Built-in seed templates bundled with TeamClaw.
 */

import type { TeamClawTemplate } from "../types.js";

export const SEED_TEMPLATE_IDS = ["default", "minimal"] as const;

const SEED_TEMPLATES: TeamClawTemplate[] = [
  {
    id: "default",
    name: "Default Team",
    description: "Standard 3-agent team with coordinator, worker, and reviewer",
    version: "1.0.0",
    author: "teamclaw",
    tags: ["default", "general"],
    agents: [
      { role: "coordinator" },
      { role: "worker" },
      { role: "reviewer" },
    ],
  },
  {
    id: "minimal",
    name: "Minimal Team",
    description: "Single worker agent for simple tasks",
    version: "1.0.0",
    author: "teamclaw",
    tags: ["minimal", "simple"],
    agents: [{ role: "worker" }],
  },
];

export function getAllSeedTemplates(): TeamClawTemplate[] {
  return [...SEED_TEMPLATES];
}

export function getSeedTemplate(id: string): TeamClawTemplate | null {
  return SEED_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function isSeedTemplate(id: string): boolean {
  return SEED_TEMPLATES.some((t) => t.id === id);
}
