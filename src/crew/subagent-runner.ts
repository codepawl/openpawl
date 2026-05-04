/**
 * Subagent invocation contract (spec §5.6).
 *
 * Every crew agent invocation flows through {@link runSubagent}. There is
 * no direct path from the orchestrator to the LLM for a crew agent — that
 * is what guarantees the Decision 1 depth limit and the Decision 4
 * capability gate hold uniformly across the codebase.
 *
 * Invariants enforced here:
 *   - Fresh message history. The system prompt is `agent_def.prompt` plus
 *     an injected capabilities block; no parent transcript leaks in.
 *   - Depth ≤ 1. `depth > 1` rejects with {@link SubagentDepthExceeded}.
 *   - Reader-only artifact view. Agent tool wiring only ever sees
 *     `ArtifactStoreReader`; the writer never crosses this boundary.
 *   - Capability gate on every tool call (see ./capability-gate.ts).
 *   - File-lock acquisition on file_write / file_edit before the
 *     underlying tool runs; `releaseAllFor(agent_id)` at turn end drains
 *     every lock held by this agent, even on thrown errors.
 *   - Token budget pre-flight. If the estimated input exceeds the
 *     `max_input` cap, reject with {@link SubagentBudgetExceeded} before
 *     making the LLM call.
 */

import { debugLog } from "../debug/logger.js";
import type { ToolDef } from "../engine/llm.js";
import type { NativeToolDefinition } from "../providers/stream-types.js";
import {
  runAgentTurn as defaultRunAgentTurn,
  type RunAgentTurnArgs,
  type RunAgentTurnResult,
  type ToolExecutor,
} from "../router/agent-turn.js";
import type { ToolCallSummary } from "../router/router-types.js";

import type { ArtifactId, ArtifactStoreReader } from "./artifacts/index.js";
import {
  formatDenialForLLM,
  gateToolCall,
  type ToolForbidden,
} from "./capability-gate.js";
import type { AgentDefinition } from "./manifest/types.js";
import { WRITE_TOOLS } from "./manifest/types.js";
import { WriteLockManager, WriteLockTimeoutError } from "./write-lock.js";

export const MAX_SUBAGENT_DEPTH = 1;
export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  max_input: 50_000,
  max_output: 16_000,
};

export interface TokenBudget {
  max_input: number;
  max_output: number;
}

export interface SubagentError {
  kind:
    | "tool_forbidden"
    | "lock_timeout"
    | "tool_exec_failure"
    | "depth_exceeded"
    | "budget_exceeded";
  tool?: string;
  message: string;
}

export interface SubagentResult {
  agent_id: string;
  summary: string;
  produced_artifacts: ArtifactId[];
  tokens_used: { input: number; output: number };
  errors: SubagentError[];
  tool_calls: ToolCallSummary[];
}

export class SubagentDepthExceeded extends Error {
  constructor(
    public readonly agent_id: string,
    public readonly depth: number,
  ) {
    super(
      `subagent depth ${depth} exceeds maximum ${MAX_SUBAGENT_DEPTH} for agent '${agent_id}'`,
    );
    this.name = "SubagentDepthExceeded";
  }
}

export class SubagentBudgetExceeded extends Error {
  constructor(
    public readonly agent_id: string,
    public readonly estimated_input_tokens: number,
    public readonly max_input_tokens: number,
  ) {
    super(
      `subagent input estimate (${estimated_input_tokens} tokens) exceeds budget (${max_input_tokens}) for agent '${agent_id}'`,
    );
    this.name = "SubagentBudgetExceeded";
  }
}

export interface RunSubagentArgs {
  agent_def: AgentDefinition;
  prompt: string;
  artifact_reader: ArtifactStoreReader;
  depth: number;
  parent_agent_id: string | null;
  write_lock_manager: WriteLockManager;
  session_id: string;
  token_budget?: TokenBudget;
  /** Underlying tool executor — already configured to honour the agent's tools. The runner wraps this with the capability gate + lock acquisition. */
  executeTool?: ToolExecutor;
  getToolSchemas?: (toolNames: string[]) => ToolDef[];
  getNativeTools?: (toolNames: string[]) => NativeToolDefinition[];
  /** Optional token estimator. Defaults to a 4-chars-per-token heuristic. */
  estimateTokens?: (text: string) => number;
  model?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  /** Per-call write-lock acquire timeout (ms). Defaults to `WriteLockManager`'s own default (30s). */
  lockTimeoutMs?: number;
  /** Test seam — defaults to the real {@link runAgentTurn}. */
  runAgentTurnImpl?: (args: RunAgentTurnArgs) => Promise<RunAgentTurnResult>;
}

const DEFAULT_TOKENIZER = (text: string): number => Math.ceil(text.length / 4);

function buildSystemPrompt(args: RunSubagentArgs): string {
  const { agent_def, depth, parent_agent_id } = args;
  const toolList =
    agent_def.tools.length > 0
      ? agent_def.tools.map((t) => `- ${t}`).join("\n")
      : "<none>";
  const scopeLine = agent_def.write_scope?.length
    ? `Your file_write / file_edit calls are restricted to paths matching:\n${agent_def.write_scope.map((g) => `  - ${g}`).join("\n")}\n`
    : "";
  const parentLine = parent_agent_id
    ? `\nYou were invoked by the orchestrator on behalf of '${parent_agent_id}'.`
    : "";
  return `${agent_def.prompt.trim()}

You are agent '${agent_def.id}' running at subagent depth ${depth}.
You must NOT spawn further subagents (depth limit ${MAX_SUBAGENT_DEPTH}).

Tools available to you:
${toolList}

${scopeLine}Tool calls outside this allowlist are blocked by the runtime capability gate; the rejection is returned to you as a tool result and counts against the doom-loop detector.${parentLine}

Artifact access is read-only; the orchestrator writes artifacts based on your output.`;
}

/**
 * Run a single crew agent. Caller owns the orchestration around this —
 * parsing the returned `summary`, writing artifacts, and merging
 * `tokens_used` into per-phase / per-session budgets.
 */
export async function runSubagent(
  args: RunSubagentArgs,
): Promise<SubagentResult> {
  const {
    agent_def,
    prompt,
    depth,
    parent_agent_id,
    write_lock_manager,
    token_budget = DEFAULT_TOKEN_BUDGET,
    executeTool,
    getToolSchemas,
    getNativeTools,
    estimateTokens = DEFAULT_TOKENIZER,
    model,
    signal,
    maxTurns,
    lockTimeoutMs,
    runAgentTurnImpl = defaultRunAgentTurn,
  } = args;

  if (depth > MAX_SUBAGENT_DEPTH) {
    debugLog("warn", "crew", "subagent_depth_exceeded", {
      data: {
        agent_id: agent_def.id,
        depth,
        parent_agent_id,
        max_depth: MAX_SUBAGENT_DEPTH,
      },
    });
    throw new SubagentDepthExceeded(agent_def.id, depth);
  }

  const systemPrompt = buildSystemPrompt(args);
  const inputEstimate = estimateTokens(systemPrompt + "\n" + prompt);

  if (inputEstimate > token_budget.max_input) {
    debugLog("warn", "crew", "subagent_budget_exceeded", {
      data: {
        agent_id: agent_def.id,
        estimated_input_tokens: inputEstimate,
        max_input_tokens: token_budget.max_input,
      },
    });
    throw new SubagentBudgetExceeded(
      agent_def.id,
      inputEstimate,
      token_budget.max_input,
    );
  }

  debugLog("info", "crew", "subagent_spawned", {
    data: {
      agent_id: agent_def.id,
      parent_agent_id,
      depth,
      tools: agent_def.tools,
      token_budget,
      session_id: args.session_id,
    },
  });

  const errors: SubagentError[] = [];
  const toolDefs = getToolSchemas ? getToolSchemas([...agent_def.tools]) : [];
  const nativeToolDefs = getNativeTools
    ? getNativeTools([...agent_def.tools])
    : [];

  const preToolHook = (name: string, toolArgs: Record<string, unknown>): string | null => {
    const decision = gateToolCall({
      agent_id: agent_def.id,
      agent_def,
      tool_name: name,
      tool_args: toolArgs,
    });
    if (decision.allowed) return null;

    const denial: ToolForbidden = decision;
    debugLog("info", "crew", "tool_forbidden", {
      data: {
        agent_id: denial.agent_id,
        tool: denial.tool,
        reason: denial.reason,
        attempted_path: denial.attempted_path,
        scope: denial.scope,
      },
    });
    errors.push({
      kind: "tool_forbidden",
      tool: denial.tool,
      message: denial.message,
    });
    return formatDenialForLLM(denial);
  };

  const wrappedExecutor: ToolExecutor | undefined = executeTool
    ? async (name, toolArgs) => {
        const isWrite = WRITE_TOOLS.has(name as never);
        const path =
          (toolArgs.path as string | undefined) ??
          (toolArgs.file as string | undefined) ??
          (toolArgs.filename as string | undefined);

        if (isWrite && typeof path === "string" && path.length > 0) {
          const lockKey = `file:${path}`;
          try {
            await write_lock_manager.acquire(lockKey, agent_def.id, lockTimeoutMs);
          } catch (err) {
            if (err instanceof WriteLockTimeoutError) {
              const msg = `[BLOCKED by write lock] file '${path}' is held by '${err.holderAgent}'; try a different file or wait`;
              errors.push({
                kind: "lock_timeout",
                tool: name,
                message: err.message,
              });
              return msg;
            }
            throw err;
          }
        }

        try {
          return await executeTool(name, toolArgs);
        } catch (err) {
          errors.push({
            kind: "tool_exec_failure",
            tool: name,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    : undefined;

  let result;
  try {
    result = await runAgentTurnImpl({
      agentId: agent_def.id,
      systemPrompt,
      userMessage: prompt,
      priorMessages: [],
      toolDefs,
      nativeToolDefs,
      executeTool: wrappedExecutor,
      preToolHook,
      model: model ?? agent_def.model,
      maxTurns,
      signal,
      source: `crew:subagent:${agent_def.id}`,
    });
  } finally {
    const released = write_lock_manager.releaseAllFor(agent_def.id);
    if (released.length > 0) {
      debugLog("debug", "crew", "subagent_locks_released", {
        data: { agent_id: agent_def.id, count: released.length, keys: released },
      });
    }
  }

  const tokens_used = {
    input: result.usage.input,
    output: result.usage.output,
  };

  if (tokens_used.output > token_budget.max_output) {
    errors.push({
      kind: "budget_exceeded",
      message: `output token usage ${tokens_used.output} exceeded budget ${token_budget.max_output}`,
    });
  }

  debugLog("info", "crew", "subagent_returned", {
    data: {
      agent_id: agent_def.id,
      depth,
      tokens_used,
      tool_call_count: result.toolCalls.length,
      error_count: errors.length,
    },
  });

  return {
    agent_id: agent_def.id,
    summary: result.text,
    // Orchestrator populates this after parsing summary + writing artifacts.
    produced_artifacts: [],
    tokens_used,
    errors,
    tool_calls: result.toolCalls,
  };
}
