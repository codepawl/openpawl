/**
 * Predefined team templates for quick setup.
 */

import { z } from "zod";
import type { BotDefinition } from "./bot-definitions.js";
import { getRoleTemplate, matchRoleIdFromLabel } from "./bot-definitions.js";

export type RosterEntry = {
  role: string;
  count: number;
  description: string;
};

export const RoleSlotSchema = z.object({
  role_id: z.string(),
  count: z.number().min(1).default(1),
  default_traits: z.record(z.unknown()).optional().default({}),
});
export type RoleSlot = z.infer<typeof RoleSlotSchema>;

export const TeamTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  slots: z.array(RoleSlotSchema).default([]),
});
export type TeamTemplate = z.infer<typeof TeamTemplateSchema>;

export const TEAM_TEMPLATES: Record<string, TeamTemplate> = {
  maker_reviewer: {
    id: "maker_reviewer",
    name: "Maker-Reviewer",
    description: "One builds, one validates — ideal for focused tasks",
    slots: [
      { role_id: "software_engineer", count: 1, default_traits: { name: "Maker" } },
      { role_id: "qa_reviewer", count: 1, default_traits: { name: "Reviewer" } },
    ],
  },
  dev_team: {
    id: "dev_team",
    name: "Dev Team",
    description: "General-purpose dev with QA",
    slots: [
      { role_id: "software_engineer", count: 2, default_traits: {} },
      { role_id: "qa_reviewer", count: 1, default_traits: {} },
    ],
  },
  fullstack: {
    id: "fullstack",
    name: "Full-Stack Team",
    description: "Frontend + backend specialists with QA",
    slots: [
      { role_id: "frontend_engineer", count: 1, default_traits: {} },
      { role_id: "backend_engineer", count: 1, default_traits: {} },
      { role_id: "qa_reviewer", count: 1, default_traits: {} },
    ],
  },
  startup: {
    id: "startup",
    name: "Startup Team",
    description: "Product-driven team with engineering, PM, and design",
    slots: [
      { role_id: "software_engineer", count: 2, default_traits: {} },
      { role_id: "product_manager", count: 1, default_traits: {} },
      { role_id: "designer", count: 1, default_traits: {} },
    ],
  },
  api_service: {
    id: "api_service",
    name: "API Service Team",
    description: "Backend engineers with docs for API-first projects",
    slots: [
      { role_id: "backend_engineer", count: 2, default_traits: {} },
      { role_id: "technical_writer", count: 1, default_traits: {} },
    ],
  },
  docs_team: {
    id: "docs_team",
    name: "Docs Team",
    description: "Technical writers + engineer for code-informed docs",
    slots: [
      { role_id: "technical_writer", count: 1, default_traits: {} },
      { role_id: "software_engineer", count: 1, default_traits: {} },
      { role_id: "editor", count: 1, default_traits: {} },
    ],
  },
  content: {
    id: "content",
    name: "Content Team",
    description: "Writer, editor, and designer for content production",
    slots: [
      { role_id: "writer", count: 1, default_traits: {} },
      { role_id: "editor", count: 1, default_traits: {} },
      { role_id: "designer", count: 1, default_traits: {} },
    ],
  },
  game_dev: {
    id: "game_dev",
    name: "Game Dev Team",
    description: "Programmers, artist, SFX, and game designer",
    slots: [
      { role_id: "software_engineer", count: 2, default_traits: {} },
      { role_id: "artist", count: 1, default_traits: {} },
      { role_id: "sfx_designer", count: 1, default_traits: {} },
      { role_id: "game_designer", count: 1, default_traits: {} },
    ],
  },
};

export function buildTeamFromTemplate(
  templateId: string,
  prefix = "bot",
  customizations: Record<string, Record<string, unknown>> | null = null
): BotDefinition[] {
  const template = TEAM_TEMPLATES[templateId];
  if (!template) return [];

  const cust = customizations ?? {};
  const bots: BotDefinition[] = [];
  let idx = 0;

    for (const slot of template.slots) {
    const role = getRoleTemplate(slot.role_id);
    const roleName = role?.name ?? slot.role_id;

    for (let i = 0; i < slot.count; i++) {
      const botId = `${prefix}_${idx}`;
      const slotTraits = { ...slot.default_traits };
      const slotKey = `${prefix}_${idx}`;
      if (slotKey in cust) Object.assign(slotTraits, cust[slotKey]);
      else if (String(idx) in cust) Object.assign(slotTraits, cust[String(idx)]);

      const customName = slotTraits.name as string | undefined;
      let displayName = customName ?? roleName;
      if (!customName && slot.count > 1) displayName = `${roleName} ${i + 1}`;

      bots.push({
        id: botId,
        name: displayName,
        role_id: slot.role_id,
        traits: slotTraits,
        worker_url: null,
      });
      idx++;
    }
  }

  return bots;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function buildTeamFromRoster(
  roster: RosterEntry[],
  prefix = "bot"
): BotDefinition[] {
  const bots: BotDefinition[] = [];
  let idx = 0;

  for (const entry of roster) {
    const roleLabel = entry.role.trim();
    const count = Math.max(1, Math.floor(entry.count));
    const desc = entry.description?.trim?.() ? String(entry.description).trim() : "";

    const knownRoleId = matchRoleIdFromLabel(roleLabel);
    const roleId = knownRoleId ?? `custom_${slugify(roleLabel) || "role"}`;
    const rt = getRoleTemplate(roleId);
    const baseName = roleLabel || rt?.name || roleId;

    for (let i = 0; i < count; i++) {
      const botId = `${prefix}_${idx}`;
      const displayName = count > 1 ? `${baseName} ${i + 1}` : baseName;
      bots.push({
        id: botId,
        name: displayName,
        role_id: roleId,
        traits: {
          role_label: roleLabel || baseName,
          role_description: desc,
        },
        worker_url: null,
      });
      idx++;
    }
  }

  return bots;
}

export function getTeamTemplate(templateId: string): TeamTemplate | null {
  return TEAM_TEMPLATES[templateId] ?? null;
}
