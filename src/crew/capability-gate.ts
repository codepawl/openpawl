/**
 * Runtime capability gate for crew agents (spec §4.3, §3 Decision 4).
 *
 * Every tool call from a crew agent flows through {@link gateToolCall}
 * before reaching the executor. The gate is the only enforcement boundary
 * for write capability — agent prompts can lie, the gate cannot.
 *
 * Two checks, in order:
 *   1. Tool allowlist: tool_name must appear in agent_def.tools.
 *   2. Write-scope glob: for file_write / file_edit only, when write_scope
 *      is set, tool_args.path must match at least one glob.
 *
 * Globs are evaluated by minimatch with `dot: true` so paths under
 * `__tests__/` and other dotfile directories match.
 *
 * The subagent runner is responsible for surfacing denials back to the
 * LLM as tool results so the agent can recover (try a different file,
 * escalate, or give up) rather than crashing the turn.
 */

import { minimatch } from "minimatch";

import type { AgentDefinition, AgentTool } from "./manifest/types.js";
import { WRITE_TOOLS } from "./manifest/types.js";

export type ToolForbiddenReason =
  | "tool_not_in_allowlist"
  | "write_outside_scope";

export interface ToolForbidden {
  agent_id: string;
  tool: string;
  reason: ToolForbiddenReason;
  message: string;
  /** Set when reason === "write_outside_scope". */
  attempted_path?: string;
  /** Set when reason === "write_outside_scope". */
  scope?: string[];
}

export interface ToolAllowed {
  allowed: true;
}

export type GateDecision = ToolAllowed | (ToolForbidden & { allowed: false });

export interface GateInput {
  agent_id: string;
  agent_def: AgentDefinition;
  tool_name: string;
  tool_args: Record<string, unknown>;
}

function isWriteTool(tool: string): tool is AgentTool {
  return WRITE_TOOLS.has(tool as AgentTool);
}

function extractPath(tool_args: Record<string, unknown>): string | null {
  const candidate = tool_args.path ?? tool_args.file ?? tool_args.filename;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function pathMatchesScope(path: string, scope: string[]): boolean {
  for (const glob of scope) {
    if (minimatch(path, glob, { dot: true, matchBase: false })) return true;
  }
  return false;
}

/**
 * Evaluate a tool call against an agent's capability set. Pure function;
 * no I/O, no side effects, no debug logging — the runner attaches the
 * decision to its own debug stream so we don't double-log.
 */
export function gateToolCall(input: GateInput): GateDecision {
  const { agent_id, agent_def, tool_name, tool_args } = input;

  if (!agent_def.tools.includes(tool_name as AgentTool)) {
    return {
      allowed: false,
      agent_id,
      tool: tool_name,
      reason: "tool_not_in_allowlist",
      message:
        `agent '${agent_id}' is not permitted to call '${tool_name}' ` +
        `(allowed: ${agent_def.tools.join(", ") || "<none>"})`,
    };
  }

  if (!isWriteTool(tool_name)) {
    return { allowed: true };
  }

  const scope = agent_def.write_scope;
  if (!scope || scope.length === 0) {
    // Write-capable agent with no scope = broad allow (default).
    return { allowed: true };
  }

  const path = extractPath(tool_args);
  if (path === null) {
    // No path argument — pass-through. The tool executor will produce
    // its own error if the call is malformed; that is not a gate concern.
    return { allowed: true };
  }

  if (pathMatchesScope(path, scope)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    agent_id,
    tool: tool_name,
    reason: "write_outside_scope",
    message:
      `agent '${agent_id}' may not write to '${path}' ` +
      `(write_scope: ${scope.join(", ")})`,
    attempted_path: path,
    scope: [...scope],
  };
}

/** Render a denial as a string the LLM should see in place of a tool result. */
export function formatDenialForLLM(denial: ToolForbidden): string {
  const lines = [
    `[BLOCKED by capability gate] ${denial.message}`,
    `reason: ${denial.reason}`,
  ];
  if (denial.attempted_path) lines.push(`attempted_path: ${denial.attempted_path}`);
  if (denial.scope) lines.push(`scope: [${denial.scope.join(", ")}]`);
  lines.push("Pick a different action; do not retry the same call.");
  return lines.join("\n");
}
