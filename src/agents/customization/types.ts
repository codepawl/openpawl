/**
 * Agent customization schema and types.
 */

import { z } from "zod";

// ─── Agent YAML Schema ───────────────────────────────────────────────────────

export const AgentYamlSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "Must be lowercase kebab-case").max(40),
  name: z.string().max(50),
  description: z.string().max(200),
  extends: z.string().optional(),

  capabilities: z.array(z.string()).optional(),

  tools: z.object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }).optional(),

  model: z.object({
    tier: z.enum(["primary", "fast", "mini"]).optional(),
    override: z.string().optional(),
    provider: z.string().optional(),
  }).optional(),

  prompt: z.object({
    system: z.string().optional(),
    prepend: z.string().optional(),
    append: z.string().optional(),
    rules: z.array(z.string()).optional(),
  }).optional(),

  personality: z.object({
    traits: z.array(z.string()).optional(),
    communicationStyle: z.object({
      tone: z.enum(["direct", "collaborative", "inquisitive", "authoritative"]).optional(),
      verbosity: z.enum(["concise", "moderate", "detailed"]).optional(),
    }).optional(),
    opinions: z.array(z.object({
      topic: z.string(),
      stance: z.string(),
      strength: z.enum(["strong", "moderate", "mild"]).optional(),
    })).optional(),
    pushbackTriggers: z.array(z.object({
      pattern: z.string(),
      response: z.string(),
      severity: z.enum(["block", "warn", "note"]).optional(),
    })).optional(),
    catchphrases: z.array(z.string()).optional(),
  }).optional(),

  behavior: z.object({
    triggerPatterns: z.array(z.string()).optional(),
    canCollaborate: z.boolean().optional(),
    maxConcurrent: z.number().int().min(1).max(10).optional(),
    confirmDestructive: z.boolean().optional(),
  }).optional(),

  meta: z.object({
    author: z.string().optional(),
    version: z.string().optional(),
    tags: z.array(z.string()).optional(),
    homepage: z.string().url().optional(),
    license: z.string().optional(),
  }).optional(),
});

export type AgentYaml = z.infer<typeof AgentYamlSchema>;

// ─── Agent Source ────────────────────────────────────────────────────────────

export type AgentSource =
  | { type: "built-in" }
  | { type: "user"; filePath: string }
  | { type: "project"; filePath: string }
  | { type: "community"; packageName: string }
  | { type: "template"; templateId: string };

// ─── Resolved Agent ──────────────────────────────────────────────────────────

export interface ResolvedAgent {
  id: string;
  name: string;
  description: string;
  source: AgentSource;
  capabilities: string[];
  defaultTools: string[];
  excludedTools: string[];
  modelTier: "primary" | "fast" | "mini";
  modelOverride?: string;
  modelProvider?: string;
  systemPrompt: string;
  personality?: ResolvedPersonality;
  triggerPatterns: string[];
  canCollaborate: boolean;
  maxConcurrent: number;
  confirmDestructive: boolean;
  meta?: AgentYaml["meta"];
  extendsChain: string[];
  rawYaml: AgentYaml;
}

export interface ResolvedPersonality {
  traits: string[];
  tone: string;
  verbosity: string;
  opinions: Array<{ topic: string; stance: string; strength: string }>;
  pushbackTriggers: Array<{ pattern: string; response: string; severity: string }>;
  catchphrases: string[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type AgentCustomizationError =
  | { type: "invalid_yaml"; file: string; cause: string }
  | { type: "schema_validation"; file: string; errors: string[] }
  | { type: "inheritance_error"; agentId: string; cause: string }
  | { type: "circular_inheritance"; chain: string[] }
  | { type: "max_depth_exceeded"; agentId: string; depth: number }
  | { type: "io_error"; cause: string }
  | { type: "community_error"; source: string; cause: string };

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationIssue {
  field: string;
  severity: "error" | "warning";
  message: string;
}

// ─── Directory Config ────────────────────────────────────────────────────────

export interface AgentDirectory {
  path: string;
  source: AgentSource["type"];
  priority: number;
}
