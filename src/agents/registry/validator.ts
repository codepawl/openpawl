/**
 * Zod validation for custom agent definitions.
 * Rejects roles that collide with built-in agents or role templates.
 */

import { z } from "zod";
import { ROLE_TEMPLATES } from "../../core/bot-definitions.js";

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Built-in agent roles that custom agents cannot use. */
const RESERVED_ROLES = new Set([
  "sprint_planning",
  "system_design",
  "rfc_phase",
  "coordinator",
  "memory_retrieval",
  "worker_task",
  "approval",
  "post_mortem",
  "retrospective",
]);

export const AgentDefinitionSchema = z.object({
  role: z.string()
    .min(1, "role is required")
    .regex(KEBAB_CASE_RE, "role must be kebab-case (e.g. \"code-reviewer\")")
    .refine(
      (r) => !RESERVED_ROLES.has(r),
      (r) => ({ message: `Role "${r}" is reserved for a built-in agent` }),
    )
    .refine(
      (r) => !(r.replace(/-/g, "_") in ROLE_TEMPLATES),
      (r) => ({ message: `Role "${r}" collides with built-in role template "${r.replace(/-/g, "_")}"` }),
    ),
  displayName: z.string().min(1, "displayName is required"),
  description: z.string().min(1, "description is required"),
  taskTypes: z.array(z.string().min(1)).min(1, "taskTypes must contain at least one entry"),
  systemPrompt: z.string().min(1, "systemPrompt is required"),
  confidenceConfig: z.object({
    minConfidence: z.number().min(0).max(1).optional(),
    flags: z.array(z.string()).optional(),
  }).optional(),
  compositionRules: z.object({
    includeKeywords: z.array(z.string()).optional(),
    excludeKeywords: z.array(z.string()).optional(),
    minComplexityScore: z.number().min(0).optional(),
    required: z.boolean().optional(),
  }).optional(),
  hooks: z.object({
    beforeTask: z.function().optional(),
    afterTask: z.function().optional(),
    onError: z.function().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
  __teamclaw_agent: z.literal(true).optional(),
});

export type ValidatedAgentDef = z.infer<typeof AgentDefinitionSchema>;

export interface ValidationResult {
  success: boolean;
  data?: ValidatedAgentDef;
  errors?: string[];
}

/** Validate an agent definition with detailed error messages. */
export function validateAgentDefinition(input: unknown): ValidationResult {
  const result = AgentDefinitionSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
