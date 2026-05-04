import { describe, expect, it } from "bun:test";

import type { ArtifactStoreReader } from "./artifacts/index.js";
import type { AgentDefinition } from "./manifest/types.js";
import {
  DEFAULT_TOKEN_BUDGET,
  MAX_SUBAGENT_DEPTH,
  SubagentBudgetExceeded,
  SubagentDepthExceeded,
  runSubagent,
  type RunSubagentArgs,
} from "./subagent-runner.js";
import { WriteLockManager } from "./write-lock.js";
import type {
  RunAgentTurnArgs,
  RunAgentTurnResult,
  ToolExecutor,
} from "../router/agent-turn.js";

const noopReader: ArtifactStoreReader = {
  read: () => null,
  list: () => [],
};

function tester(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "tester",
    name: "Tester",
    description: "writes tests",
    prompt: "You are the tester. Run the suite and report.",
    tools: ["file_read", "file_write", "shell_exec"],
    write_scope: ["**/*.test.ts", "**/__tests__/**"],
    ...overrides,
  };
}

function reviewer(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "reviewer",
    name: "Reviewer",
    description: "reviews code",
    prompt: "You are the reviewer. Audit the diff.",
    tools: ["file_read", "file_list"],
    ...overrides,
  };
}

interface CapturedExecutor {
  args: { name: string; args: Record<string, unknown> }[];
  preToolHookOutputs: (string | null)[];
}

/**
 * Build a stub `runAgentTurn` that:
 *   - calls the supplied preToolHook for each scripted tool call
 *   - if the hook returns null, calls the executor and records its return
 *   - returns a SubagentResult-shaped response
 */
function stubRunAgentTurn(
  scriptedCalls: Array<{ name: string; args: Record<string, unknown> }>,
  capture: CapturedExecutor,
  finalText = "stub summary",
  usage = { input: 100, output: 50 },
): (args: RunAgentTurnArgs) => Promise<RunAgentTurnResult> {
  return async (turnArgs) => {
    for (const call of scriptedCalls) {
      const hookResult =
        (await turnArgs.preToolHook?.(call.name, call.args)) ?? null;
      capture.preToolHookOutputs.push(hookResult);
      if (hookResult !== null) continue;
      capture.args.push(call);
      if (turnArgs.executeTool) {
        await turnArgs.executeTool(call.name, call.args);
      }
    }
    return {
      text: finalText,
      toolCalls: scriptedCalls.map((c, i) => ({
        tool: c.name,
        input: JSON.stringify(c.args),
        output: `result-${i}`,
        duration: 1,
        success: true,
      })),
      usage,
    };
  };
}

function makeArgs(overrides: Partial<RunSubagentArgs> = {}): RunSubagentArgs {
  return {
    agent_def: tester(),
    prompt: "Write tests for src/foo.ts",
    artifact_reader: noopReader,
    depth: 0,
    parent_agent_id: "orchestrator",
    write_lock_manager: new WriteLockManager(),
    session_id: "s1",
    ...overrides,
  };
}

describe("runSubagent — depth limit", () => {
  it("rejects depth > 1 with SubagentDepthExceeded", async () => {
    let caught: unknown = null;
    try {
      await runSubagent(makeArgs({ depth: 2 }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SubagentDepthExceeded);
  });

  it("allows depth 0 and depth 1", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const stub = stubRunAgentTurn([], capture);

    const r0 = await runSubagent(
      makeArgs({ depth: 0, runAgentTurnImpl: stub }),
    );
    expect(r0.errors).toEqual([]);

    const r1 = await runSubagent(
      makeArgs({ depth: MAX_SUBAGENT_DEPTH, runAgentTurnImpl: stub }),
    );
    expect(r1.errors).toEqual([]);
  });
});

describe("runSubagent — token budget", () => {
  it("rejects with SubagentBudgetExceeded when input estimate exceeds max_input", async () => {
    const longPrompt = "x".repeat(50_000);
    let caught: unknown = null;
    try {
      await runSubagent(
        makeArgs({
          prompt: longPrompt,
          token_budget: { max_input: 100, max_output: 100 },
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SubagentBudgetExceeded);
  });

  it("admits a normal prompt under the default budget", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const r = await runSubagent(
      makeArgs({
        runAgentTurnImpl: stubRunAgentTurn([], capture),
      }),
    );
    expect(r.tokens_used).toEqual({ input: 100, output: 50 });
  });

  it("flags an output budget overflow as a non-fatal error", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const stub = stubRunAgentTurn([], capture, "overflow", {
      input: 100,
      output: 99_999,
    });
    const r = await runSubagent(
      makeArgs({
        token_budget: DEFAULT_TOKEN_BUDGET,
        runAgentTurnImpl: stub,
      }),
    );
    expect(r.errors.some((e) => e.kind === "budget_exceeded")).toBe(true);
  });
});

describe("runSubagent — capability gate routing", () => {
  it("blocks a tool not in the agent's allowlist via preToolHook", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const calls = [{ name: "git_ops", args: { command: "push" } }];
    const stub = stubRunAgentTurn(calls, capture);
    const exec: ToolExecutor = async () => "should-not-run";

    const r = await runSubagent(
      makeArgs({
        agent_def: reviewer(),
        executeTool: exec,
        runAgentTurnImpl: stub,
      }),
    );

    expect(capture.args.length).toBe(0); // executor not called
    expect(capture.preToolHookOutputs[0]).toContain("[BLOCKED by capability gate]");
    expect(capture.preToolHookOutputs[0]).toContain("tool_not_in_allowlist");
    expect(r.errors.some((e) => e.kind === "tool_forbidden" && e.tool === "git_ops")).toBe(true);
  });

  it("blocks a write outside write_scope (tester writing to src/foo.ts)", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const calls = [{ name: "file_write", args: { path: "src/foo.ts", content: "x" } }];
    const stub = stubRunAgentTurn(calls, capture);
    const exec: ToolExecutor = async () => "wrote";

    const r = await runSubagent(
      makeArgs({
        agent_def: tester(),
        executeTool: exec,
        runAgentTurnImpl: stub,
      }),
    );

    expect(capture.args.length).toBe(0);
    expect(capture.preToolHookOutputs[0]).toContain("write_outside_scope");
    expect(r.errors.some((e) => e.kind === "tool_forbidden")).toBe(true);
  });

  it("admits a write inside write_scope and lets the executor run", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const calls = [
      { name: "file_write", args: { path: "src/foo.test.ts", content: "tests" } },
    ];
    const stub = stubRunAgentTurn(calls, capture);
    const exec: ToolExecutor = async () => "wrote";

    const r = await runSubagent(
      makeArgs({
        agent_def: tester(),
        executeTool: exec,
        runAgentTurnImpl: stub,
      }),
    );

    expect(capture.args.length).toBe(1);
    expect(capture.preToolHookOutputs[0]).toBeNull();
    expect(r.errors).toEqual([]);
  });
});

describe("runSubagent — write-lock acquisition", () => {
  it("acquires file:<path> for file_write and releases at turn end", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const locks = new WriteLockManager();
    const calls = [
      { name: "file_write", args: { path: "src/foo.test.ts", content: "x" } },
    ];

    const observed: { holder: string | null }[] = [];
    const exec: ToolExecutor = async () => {
      observed.push({ holder: locks.holderOf("file:src/foo.test.ts") });
      return "wrote";
    };
    const stub = stubRunAgentTurn(calls, capture);

    const r = await runSubagent(
      makeArgs({
        write_lock_manager: locks,
        executeTool: exec,
        runAgentTurnImpl: stub,
      }),
    );

    // During exec, the lock is held by the agent.
    expect(observed[0]?.holder).toBe("tester");
    // After turn end, the lock is released.
    expect(locks.isHeld("file:src/foo.test.ts")).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it("converts a lock timeout into a tool result and records a lock_timeout error", async () => {
    const locks = new WriteLockManager();
    await locks.acquire("file:src/foo.test.ts", "other-agent");

    const calls = [
      { name: "file_write", args: { path: "src/foo.test.ts", content: "x" } },
    ];
    const exec: ToolExecutor = async () => "should-not-run";
    const stub: (args: RunAgentTurnArgs) => Promise<RunAgentTurnResult> = async (
      turnArgs,
    ) => {
      // The runner's wrapped executor handles the lock acquire — call it directly.
      let result: string | null = null;
      try {
        const raw = await turnArgs.executeTool!(calls[0]!.name, calls[0]!.args);
        result = typeof raw === "string" ? raw : raw.text;
      } catch (e) {
        result = e instanceof Error ? e.message : String(e);
      }
      return {
        text: result ?? "",
        toolCalls: [],
        usage: { input: 10, output: 10 },
      };
    };

    const r = await runSubagent(
      makeArgs({
        write_lock_manager: locks,
        executeTool: exec,
        runAgentTurnImpl: stub,
        token_budget: { max_input: 10_000, max_output: 1_000 },
        lockTimeoutMs: 50,
      }),
    );

    expect(r.summary).toContain("[BLOCKED by write lock]");
    expect(r.errors.some((e) => e.kind === "lock_timeout")).toBe(true);
    locks.release("file:src/foo.test.ts", "other-agent");
  });

  it("releases all locks held by the agent on turn end (even with multiple writes)", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const locks = new WriteLockManager();
    const calls = [
      { name: "file_write", args: { path: "a.test.ts", content: "x" } },
      { name: "file_write", args: { path: "b.test.ts", content: "y" } },
    ];
    const exec: ToolExecutor = async () => "wrote";
    const stub = stubRunAgentTurn(calls, capture);

    await runSubagent(
      makeArgs({
        write_lock_manager: locks,
        executeTool: exec,
        runAgentTurnImpl: stub,
      }),
    );

    expect(locks.isHeld("file:a.test.ts")).toBe(false);
    expect(locks.isHeld("file:b.test.ts")).toBe(false);
  });

  it("releases locks even when runAgentTurn throws", async () => {
    const locks = new WriteLockManager();
    const stub: (args: RunAgentTurnArgs) => Promise<RunAgentTurnResult> = async (
      turnArgs,
    ) => {
      // Acquire a lock through the wrapped executor, then throw.
      await turnArgs.executeTool!("file_write", { path: "x.test.ts", content: "x" });
      throw new Error("simulated runner crash");
    };
    const exec: ToolExecutor = async () => "wrote";

    let caught: unknown = null;
    try {
      await runSubagent(
        makeArgs({
          write_lock_manager: locks,
          executeTool: exec,
          runAgentTurnImpl: stub,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(locks.isHeld("file:x.test.ts")).toBe(false);
  });
});

describe("runSubagent — return shape", () => {
  it("returns the structured SubagentResult contract", async () => {
    const capture: CapturedExecutor = { args: [], preToolHookOutputs: [] };
    const stub = stubRunAgentTurn(
      [{ name: "file_read", args: { path: "src/foo.ts" } }],
      capture,
      "I read the file.",
      { input: 250, output: 75 },
    );
    const exec: ToolExecutor = async () => "file contents";

    const r = await runSubagent(
      makeArgs({
        agent_def: reviewer(),
        executeTool: exec,
        runAgentTurnImpl: stub,
      }),
    );

    expect(r.agent_id).toBe("reviewer");
    expect(r.summary).toBe("I read the file.");
    expect(r.produced_artifacts).toEqual([]);
    expect(r.tokens_used).toEqual({ input: 250, output: 75 });
    expect(r.tool_calls.length).toBe(1);
    expect(r.errors).toEqual([]);
  });
});
