/**
 * Template validator — validates template JSON against rules.
 */

import type { TeamClawTemplate } from "./types.js";

export interface TemplateValidationResult {
  valid: boolean;
  data?: TeamClawTemplate;
  errors: string[];
}

export type ValidatedTemplate = TeamClawTemplate;

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

export const TeamClawTemplateSchema = {
  parse(data: unknown): TeamClawTemplate {
    const result = validateTemplate(data);
    if (!result.valid) throw new Error(result.errors.join(", "));
    return result.data!;
  },
};

export function validateTemplate(data: unknown): TemplateValidationResult {
  const errors: string[] = [];
  const obj = data as Record<string, unknown>;

  if (!obj || typeof obj !== "object") {
    return { valid: false, errors: ["Input must be an object"] };
  }

  // id: required, kebab-case
  if (typeof obj.id !== "string" || !obj.id) {
    errors.push("Missing or invalid 'id'");
  } else if (!KEBAB_CASE_RE.test(obj.id as string)) {
    errors.push("'id' must be kebab-case (e.g. 'my-template')");
  }

  // name: required
  if (typeof obj.name !== "string" || !obj.name) {
    errors.push("Missing or invalid 'name'");
  }

  // description: required, max 200 chars
  if (typeof obj.description !== "string") {
    errors.push("Missing 'description'");
  } else if ((obj.description as string).length > 200) {
    errors.push("'description' must be 200 characters or fewer");
  }

  // version: required, semver
  if (typeof obj.version !== "string") {
    errors.push("Missing 'version'");
  } else if (!SEMVER_RE.test(obj.version as string)) {
    errors.push("'version' must be valid semver (e.g. '1.0.0')");
  }

  // author: required
  if (typeof obj.author !== "string" || !obj.author) {
    errors.push("Missing or invalid 'author'");
  }

  // tags: required, max 5
  if (!Array.isArray(obj.tags)) {
    errors.push("'tags' must be an array");
  } else if ((obj.tags as unknown[]).length > 5) {
    errors.push("'tags' must have 5 or fewer entries");
  }

  // agents: required, non-empty
  if (!Array.isArray(obj.agents)) {
    errors.push("'agents' must be an array");
  } else if ((obj.agents as unknown[]).length === 0) {
    errors.push("'agents' must contain at least one agent");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: obj as TeamClawTemplate, errors: [] };
}
