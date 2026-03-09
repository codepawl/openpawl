/**
 * Bot definitions and role templates for team orchestration.
 */

import { z } from "zod";

export const RoleTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  skills: z.array(z.string()).default([]),
  task_types: z.array(z.string()).default([]),
  default_traits: z.record(z.unknown()).default({}),
});
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

export const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  software_engineer: {
    id: "software_engineer",
    name: "Software Engineer",
    skills: ["frontend", "backend", "algorithms"],
    task_types: ["code", "debug", "review", "api", "database", "refactor"],
    default_traits: { focus: "technical implementation" },
  },
  artist: {
    id: "artist",
    name: "Artist",
    skills: ["2d", "3d", "concept"],
    task_types: ["asset", "sprite", "texture", "model", "animation", "ui_art"],
    default_traits: { focus: "visual assets" },
  },
  sfx_designer: {
    id: "sfx_designer",
    name: "SFX Designer",
    skills: ["audio", "foley", "music"],
    task_types: ["sound", "music", "mix", "foley", "ambient"],
    default_traits: { focus: "audio and sound design" },
  },
  game_designer: {
    id: "game_designer",
    name: "Game Designer",
    skills: ["mechanics", "narrative", "balance"],
    task_types: ["design", "balance", "docs", "gdd", "prototype"],
    default_traits: { focus: "game design and documentation" },
  },
  product_manager: {
    id: "product_manager",
    name: "Product Manager",
    skills: ["prioritization", "roadmap", "stakeholders"],
    task_types: ["plan", "spec", "prioritize", "coordinate"],
    default_traits: { focus: "product strategy and coordination" },
  },
  designer: {
    id: "designer",
    name: "Designer",
    skills: ["ux", "ui", "visual"],
    task_types: ["wireframe", "mockup", "ux", "ui"],
    default_traits: { focus: "user experience and visual design" },
  },
  writer: {
    id: "writer",
    name: "Writer",
    skills: ["copy", "narrative", "editing"],
    task_types: ["copy", "story", "script", "documentation"],
    default_traits: { focus: "written content" },
  },
  editor: {
    id: "editor",
    name: "Editor",
    skills: ["editing", "review", "consistency"],
    task_types: ["edit", "review", "proofread"],
    default_traits: { focus: "content review and polish" },
  },
};

export function getRoleTemplate(roleId: string): RoleTemplate | null {
  return ROLE_TEMPLATES[roleId] ?? null;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/**
 * Attempts to map a human-facing role label (e.g. "Software Engineer")
 * to a known internal role id (e.g. "software_engineer") so skills/task_types apply.
 * Returns null if no known role matches.
 */
export function matchRoleIdFromLabel(roleLabel: string): string | null {
  const raw = roleLabel.trim();
  if (!raw) return null;

  // Direct id match
  if (raw in ROLE_TEMPLATES) return raw;

  const n = norm(raw);
  for (const [id, tpl] of Object.entries(ROLE_TEMPLATES)) {
    if (norm(tpl.name) === n) return id;
    if (norm(id) === n) return id;
  }
  return null;
}

export function getMergedTraits(
  roleId: string,
  userOverrides: Record<string, unknown> | null = null
): Record<string, unknown> {
  const template = getRoleTemplate(roleId);
  const base: Record<string, unknown> = {};
  if (template) {
    Object.assign(base, template.default_traits);
    base.skills = template.skills;
    base.task_types = template.task_types;
  }
  Object.assign(base, userOverrides ?? {});
  return base;
}

export const BotDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  role_id: z.string(),
  traits: z.record(z.unknown()).default({}),
  worker_url: z.string().nullable().default(null),
  adapter_type: z.enum(["openclaw"]).optional(),
});
export type BotDefinition = z.infer<typeof BotDefinitionSchema>;

export function getEffectiveTraits(bot: BotDefinition): Record<string, unknown> {
  return getMergedTraits(bot.role_id, bot.traits);
}

export function getRoleName(bot: BotDefinition): string {
  const template = getRoleTemplate(bot.role_id);
  return template?.name ?? bot.role_id;
}
