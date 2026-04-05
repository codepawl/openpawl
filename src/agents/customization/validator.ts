/**
 * Deep validation for agent definitions beyond schema checks.
 */

import { Result, ok, err } from "neverthrow";
import type { AgentYaml, ValidationIssue } from "./types.js";

export class AgentValidator {
  constructor(
    private builtInIds: Set<string>,
    private knownToolNames: Set<string>,
  ) {}

  validate(yaml: AgentYaml): Result<void, ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // ID conflicts with built-in (without extends)
    if (this.builtInIds.has(yaml.id) && yaml.extends !== yaml.id) {
      issues.push({
        field: "id",
        severity: "error",
        message: `Agent ID '${yaml.id}' conflicts with built-in agent. Use extends: ${yaml.id} to customize it.`,
      });
    }

    // Unknown tools
    if (yaml.tools?.include) {
      for (const tool of yaml.tools.include) {
        if (this.knownToolNames.size > 0 && !this.knownToolNames.has(tool)) {
          issues.push({
            field: "tools.include",
            severity: "error",
            message: `Tool '${tool}' not found in registry.`,
          });
        }
      }
    }

    // Invalid regex in trigger patterns
    if (yaml.behavior?.triggerPatterns) {
      for (let i = 0; i < yaml.behavior.triggerPatterns.length; i++) {
        try {
          new RegExp(yaml.behavior.triggerPatterns[i]!);
        } catch {
          issues.push({
            field: `behavior.triggerPatterns[${i}]`,
            severity: "error",
            message: `Invalid regex: ${yaml.behavior.triggerPatterns[i]}`,
          });
        }
      }
    }

    // System prompt too long
    if (yaml.prompt?.system && yaml.prompt.system.length > 5000) {
      issues.push({
        field: "prompt.system",
        severity: "error",
        message: `System prompt too long (${yaml.prompt.system.length} chars). Max 5000.`,
      });
    }

    // Warnings
    if (!yaml.description) {
      issues.push({ field: "description", severity: "warning", message: "Missing description." });
    }

    if (!yaml.capabilities?.length && !yaml.extends) {
      issues.push({ field: "capabilities", severity: "warning", message: "No capabilities defined." });
    }

    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) return err(issues);
    return ok(undefined);
  }
}
