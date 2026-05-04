/**
 * Manifest validator.
 *
 * Layered on top of the Zod schemas: Zod handles structural shape, this
 * module enforces cross-field rules:
 *   - agent count vs constraints.min_agents / max_agents (errors)
 *   - agent count vs constraints.recommended_range (warnings)
 *   - duplicate agent ids
 *   - required_roles must each be present
 *   - write_scope globs are syntactically safe and non-escaping
 *   - write_scope on a non-write-capable agent (warning, ignored at runtime)
 *   - crew with no write-capable agent (warning, per spec §6.5)
 *
 * Real glob matching at runtime is the capability gate's job (Prompt 5);
 * here we only reject malformed or escape-prone patterns.
 */

import {
  CrewConstraintsSchema,
  CrewManifestSchema,
  WRITE_TOOLS,
  type CrewManifest,
} from "./types.js";

export interface ValidationIssue {
  severity: "error" | "warn";
  message: string;
  agent_id?: string;
  glob?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  manifest?: CrewManifest;
}

const SAFE_GLOB_RE = /^[a-zA-Z0-9_\-./*?{},!\[\]]+$/;

function validateGlob(glob: string): { ok: true } | { ok: false; message: string } {
  if (glob.length === 0) return { ok: false, message: "write_scope glob is empty" };
  if (!SAFE_GLOB_RE.test(glob)) {
    return {
      ok: false,
      message: `write_scope glob contains unsupported characters: '${glob}'`,
    };
  }
  if (glob.includes("..")) {
    return { ok: false, message: `write_scope glob must not contain '..': '${glob}'` };
  }
  if (glob.startsWith("/")) {
    return { ok: false, message: `write_scope glob must be repo-relative: '${glob}'` };
  }
  return { ok: true };
}

export function validateManifest(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const parsed = CrewManifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        severity: "error",
        message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      });
    }
    return { ok: false, errors, warnings };
  }
  const manifest = parsed.data;

  // Constraints sanity (parsed default already applied, but re-check explicit fields)
  const constraintsParsed = CrewConstraintsSchema.safeParse(manifest.constraints);
  if (!constraintsParsed.success) {
    for (const issue of constraintsParsed.error.issues) {
      errors.push({
        severity: "error",
        message: `constraints.${issue.path.join(".")}: ${issue.message}`,
      });
    }
  }
  const c = constraintsParsed.success ? constraintsParsed.data : manifest.constraints;

  if (c.min_agents > c.max_agents) {
    errors.push({
      severity: "error",
      message: `constraints.min_agents (${c.min_agents}) exceeds max_agents (${c.max_agents})`,
    });
  }
  if (manifest.agents.length < c.min_agents) {
    errors.push({
      severity: "error",
      message: `agent count ${manifest.agents.length} below min_agents ${c.min_agents}`,
    });
  }
  if (manifest.agents.length > c.max_agents) {
    errors.push({
      severity: "error",
      message: `agent count ${manifest.agents.length} above max_agents ${c.max_agents}`,
    });
  }
  const [recMin, recMax] = c.recommended_range;
  if (manifest.agents.length < recMin || manifest.agents.length > recMax) {
    warnings.push({
      severity: "warn",
      message: `agent count ${manifest.agents.length} outside recommended range ${recMin}-${recMax}`,
    });
  }

  // Duplicate agent ids
  const seen = new Set<string>();
  for (const a of manifest.agents) {
    if (seen.has(a.id)) {
      errors.push({
        severity: "error",
        agent_id: a.id,
        message: `duplicate agent id: '${a.id}'`,
      });
    }
    seen.add(a.id);
  }

  // Required roles
  for (const role of c.required_roles) {
    if (!manifest.agents.some((a) => a.id === role)) {
      errors.push({
        severity: "error",
        message: `required role missing from manifest: '${role}'`,
      });
    }
  }

  // Write scope checks
  let anyWriteCapable = false;
  for (const agent of manifest.agents) {
    const hasWriteTool = agent.tools.some((t) => WRITE_TOOLS.has(t));
    if (hasWriteTool) anyWriteCapable = true;
    if (agent.write_scope) {
      if (!hasWriteTool) {
        warnings.push({
          severity: "warn",
          agent_id: agent.id,
          message: `agent '${agent.id}' has write_scope but no write tools — write_scope will be ignored`,
        });
      }
      for (const glob of agent.write_scope) {
        const g = validateGlob(glob);
        if (!g.ok) {
          errors.push({ severity: "error", agent_id: agent.id, glob, message: g.message });
        }
      }
    }
  }
  if (!anyWriteCapable) {
    warnings.push({
      severity: "warn",
      message: "no agent in this crew has file_write or file_edit — manual confirmation recommended (spec §6.5)",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest: errors.length === 0 ? manifest : undefined,
  };
}
