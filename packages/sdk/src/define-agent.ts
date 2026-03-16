/**
 * defineAgent() — validates and brands a custom agent definition.
 * Pure function with zero runtime dependencies.
 */

import type { AgentDefinition, ValidatedAgentDefinition } from "./types.js";

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Validate and create a branded agent definition. */
export function defineAgent(def: AgentDefinition): ValidatedAgentDefinition {
  if (!def.role || typeof def.role !== "string") {
    throw new Error("Agent role is required and must be a string");
  }
  if (!KEBAB_CASE_RE.test(def.role)) {
    throw new Error(
      `Agent role "${def.role}" must be kebab-case (e.g. "code-reviewer"). ` +
      `Only lowercase letters, numbers, and hyphens allowed.`
    );
  }

  if (!def.displayName || typeof def.displayName !== "string") {
    throw new Error("Agent displayName is required and must be a non-empty string");
  }
  if (!def.description || typeof def.description !== "string") {
    throw new Error("Agent description is required and must be a non-empty string");
  }
  if (!def.systemPrompt || typeof def.systemPrompt !== "string") {
    throw new Error("Agent systemPrompt is required and must be a non-empty string");
  }
  if (!Array.isArray(def.taskTypes) || def.taskTypes.length === 0) {
    throw new Error("Agent taskTypes must be a non-empty array of strings");
  }
  for (const t of def.taskTypes) {
    if (typeof t !== "string" || !t.trim()) {
      throw new Error("Each taskType must be a non-empty string");
    }
  }

  // Validate optional fields
  if (def.confidenceConfig) {
    if (def.confidenceConfig.minConfidence != null) {
      const mc = def.confidenceConfig.minConfidence;
      if (typeof mc !== "number" || mc < 0 || mc > 1) {
        throw new Error("confidenceConfig.minConfidence must be a number between 0 and 1");
      }
    }
    if (def.confidenceConfig.flags) {
      if (!Array.isArray(def.confidenceConfig.flags)) {
        throw new Error("confidenceConfig.flags must be an array of strings");
      }
    }
  }

  if (def.compositionRules) {
    const r = def.compositionRules;
    if (r.includeKeywords && !Array.isArray(r.includeKeywords)) {
      throw new Error("compositionRules.includeKeywords must be an array");
    }
    if (r.excludeKeywords && !Array.isArray(r.excludeKeywords)) {
      throw new Error("compositionRules.excludeKeywords must be an array");
    }
    if (r.minComplexityScore != null && (typeof r.minComplexityScore !== "number" || r.minComplexityScore < 0)) {
      throw new Error("compositionRules.minComplexityScore must be a non-negative number");
    }
  }

  return Object.freeze({
    ...def,
    __teamclaw_agent: true as const,
  });
}

/** Check if a value is a branded agent definition. */
export function isAgentDefinition(value: unknown): value is ValidatedAgentDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__teamclaw_agent === true
  );
}
