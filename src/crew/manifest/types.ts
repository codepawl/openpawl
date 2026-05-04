/**
 * Crew manifest schemas.
 *
 * Two flavours:
 *   - `RawCrewManifest` — what gets parsed from manifest.yaml on disk;
 *     prompts are referenced by `prompt_file` rather than inlined.
 *   - `CrewManifest` — fully resolved manifest with prompt content read
 *     into `prompt`. The runtime always works with the resolved form.
 *
 * AgentDefinition extends the spec §4.1 surface with `write_scope`, the
 * glob list used by the capability gate (Prompt 5) to constrain which
 * paths a write-capable agent may touch.
 */

import { z } from "zod";

export const AGENT_TOOLS = [
  "file_read",
  "file_write",
  "file_edit",
  "file_list",
  "shell_exec",
  "web_search",
  "web_fetch",
  "git_ops",
] as const;

export const AgentToolSchema = z.enum(AGENT_TOOLS);
export type AgentTool = z.infer<typeof AgentToolSchema>;

export const WRITE_TOOLS: ReadonlySet<AgentTool> = new Set(["file_write", "file_edit"]);

export const AGENT_ID_PATTERN = /^[a-z0-9-]+$/;

const agentBaseShape = {
  id: z.string().min(1).max(50).regex(AGENT_ID_PATTERN),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  tools: z.array(AgentToolSchema).min(0),
  write_scope: z.array(z.string().min(1)).optional(),
  model: z.string().optional(),
};

/** Resolved form: prompt content is mandatory and inlined. */
export const AgentDefinitionSchema = z.object({
  ...agentBaseShape,
  prompt: z.string().min(10),
  prompt_file: z.string().min(1).optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Raw form parsed from YAML: prompt_file required, prompt optional. */
export const RawAgentDefinitionSchema = z.object({
  ...agentBaseShape,
  prompt_file: z.string().min(1),
  prompt: z.string().min(1).optional(),
});
export type RawAgentDefinition = z.infer<typeof RawAgentDefinitionSchema>;

export const CrewConstraintsSchema = z.object({
  min_agents: z.number().int().min(2).max(10).default(2),
  max_agents: z.number().int().min(2).max(10).default(10),
  recommended_range: z
    .tuple([z.number().int(), z.number().int()])
    .default([3, 5]),
  required_roles: z.array(z.string()).default([]),
});
export type CrewConstraints = z.infer<typeof CrewConstraintsSchema>;

const manifestBaseShape = {
  name: z.string().min(1).max(50).regex(AGENT_ID_PATTERN),
  description: z.string().max(500),
  version: z.string().default("1.0.0"),
  constraints: CrewConstraintsSchema.default({
    min_agents: 2,
    max_agents: 10,
    recommended_range: [3, 5],
    required_roles: [],
  }),
};

export const CrewManifestSchema = z.object({
  ...manifestBaseShape,
  agents: z.array(AgentDefinitionSchema).min(2).max(10),
});
export type CrewManifest = z.infer<typeof CrewManifestSchema>;

export const RawCrewManifestSchema = z.object({
  ...manifestBaseShape,
  agents: z.array(RawAgentDefinitionSchema).min(2).max(10),
});
export type RawCrewManifest = z.infer<typeof RawCrewManifestSchema>;
