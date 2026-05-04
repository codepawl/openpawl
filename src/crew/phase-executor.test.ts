import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BudgetTracker } from "./budget-tracker.js";
import { KnownFilesRegistry } from "./known-files.js";
import { executePhase } from "./phase-executor.js";
import {
  CrewPhaseSchema,
  CrewTaskSchema,
  type CrewPhase,
} from "./types.js";
import { WriteLockManager } from "./write-lock.js";
import type { CrewManifest } from "./manifest/index.js";
import type {
  RunSubagentArgs,
  SubagentDebugInfo,
  SubagentResult,
} from "./subagent-runner.js";
import type { ToolCallSummary } from "../router/router-types.js";

const noopReader = {
  read: () => null,
  list: () => [],
};

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(os.tmpdir(), "openpawl-phase-exec-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function manifest(): CrewManifest {
  return {
    name: "full-stack",
    description: "test",
    version: "1.0.0",
    constraints: {
      min_agents: 2,
      max_agents: 10,
      recommended_range: [3, 5],
      required_roles: [],
    },
    agents: [
      {
        id: "planner",
        name: "Planner",
        description: "x",
        prompt: "Planner prompt.",
        tools: ["file_read", "file_list"],
      },
      {
        id: "coder",
        name: "Coder",
        description: "x",
        prompt: "Coder prompt.",
        tools: ["file_read", "file_list", "file_write", "file_edit", "shell_exec"],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        description: "x",
        prompt: "Reviewer prompt.",
        tools: ["file_read", "file_list"],
      },
      {
        id: "tester",
        name: "Tester",
        description: "x",
        prompt: "Tester prompt.",
        tools: ["file_read", "file_write", "shell_exec"],
        write_scope: ["**/*.test.ts"],
      },
    ],
  };
}

function makeTask(
  id: string,
  description: string,
  opts: { agent?: string; depends_on?: string[]; phase_id?: string } = {},
) {
  return CrewTaskSchema.parse({
    id,
    phase_id: opts.phase_id ?? "p1",
    description,
    assigned_agent: opts.agent ?? "coder",
    depends_on: opts.depends_on ?? [],
    max_tokens_per_task: 50_000,
  });
}

function makePhase(
  id: string,
  tasks: ReturnType<typeof makeTask>[],
  tier: "1" | "2" | "3" = "2",
): CrewPhase {
  return CrewPhaseSchema.parse({
    id,
    name: id,
    description: "test phase",
    complexity_tier: tier,
    tasks,
  });
}

interface StubScript {
  /** Files the agent should claim to have created (must exist on disk for validator pass). */
  files_created?: string[];
  files_modified?: string[];
  /** ToolCallSummary entries to surface to phase-executor. */
  tool_calls?: ToolCallSummary[];
  /** Override summary text. */
  summary?: string;
  /** Tokens used (sum). */
  tokens_used?: number;
  /** Tokens breakdown override. */
  tokens_breakdown?: { input: number; output: number };
  /** Side effect: actually write the files to disk before responding. */
  diskWrites?: { rel: string; content: string }[];
  /** Throw an error from runSubagent. */
  throw?: Error;
}

function fileWriteToolCall(p: string, success = true): ToolCallSummary {
  return {
    tool: "file_write",
    input: JSON.stringify({ path: p, content: "x" }),
    output: success ? "wrote" : "error",
    duration: 1,
    success,
  };
}

function shellFailToolCall(stderr: string, exit = 127): ToolCallSummary {
  return {
    tool: "shell_exec",
    input: JSON.stringify({ command: "bun run build" }),
    output: stderr,
    duration: 1,
    success: false,
    exitCode: exit,
    stderrHead: stderr,
  };
}

function stubSubagent(
  scripts: Record<string, StubScript[]>,
): {
  impl: (args: RunSubagentArgs) => Promise<SubagentResult>;
  callCount: () => number;
  taskCalls: () => string[];
} {
  const counters = new Map<string, number>();
  const taskCalls: string[] = [];
  return {
    callCount: () => taskCalls.length,
    taskCalls: () => taskCalls,
    impl: async (callArgs) => {
      // Identify the task by parsing the prompt's "# Task <id>" header.
      const m = callArgs.prompt.match(/^# Task (\S+)/m);
      const taskId = m?.[1] ?? "unknown";
      taskCalls.push(taskId);
      const list = scripts[taskId] ?? [];
      const idx = counters.get(taskId) ?? 0;
      counters.set(taskId, idx + 1);
      const script: StubScript = list[Math.min(idx, list.length - 1)] ?? {};

      if (script.throw) throw script.throw;

      // Apply disk writes BEFORE returning so the validator sees them.
      for (const w of script.diskWrites ?? []) {
        const abs = path.join(workdir, w.rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, w.content, "utf-8");
      }

      const breakdown = script.tokens_breakdown ?? { input: 100, output: 50 };
      const debug: SubagentDebugInfo = {
        agent_id: callArgs.agent_def.id,
        depth: callArgs.depth,
        errors: [],
        tool_calls: script.tool_calls ?? [],
        tokens_breakdown: breakdown,
      };
      callArgs.onDebug?.(debug);

      return {
        summary: script.summary ?? "stub completion",
        produced_artifacts: [],
        tokens_used: script.tokens_used ?? breakdown.input + breakdown.output,
        tokens_breakdown: breakdown,
      };
    },
  };
}

function makeContext(phase: CrewPhase) {
  return {
    phase,
    manifest: manifest(),
    workdir,
    artifact_reader: noopReader,
    write_lock_manager: new WriteLockManager(),
    known_files: new KnownFilesRegistry(),
    budget_tracker: new BudgetTracker({
      max_tokens_per_session: 1_000_000,
      max_tokens_per_phase: 200_000,
    }),
    session_id: "s1",
  };
}

describe("executePhase — happy path", () => {
  it("executes a single task that creates a file", async () => {
    const phase = makePhase("p1", [
      makeTask("t1", "Create src/foo.ts with the content"),
    ]);
    const stub = stubSubagent({
      t1: [
        {
          diskWrites: [{ rel: "src/foo.ts", content: "export const x = 1;" }],
          tool_calls: [fileWriteToolCall("src/foo.ts")],
          summary: "Created src/foo.ts",
        },
      ],
    });
    const ctx = makeContext(phase);

    const r = await executePhase({ ...ctx, runSubagentImpl: stub.impl });

    expect(r.ended_by).toBe("all_complete");
    expect(r.task_count.completed).toBe(1);
    expect(phase.tasks[0]?.status).toBe("completed");
    expect(phase.tasks[0]?.files_created).toEqual(["src/foo.ts"]);
    expect(r.files_created).toEqual(["src/foo.ts"]);
    expect(ctx.known_files.has("src/foo.ts")).toBe(true);
  });

  it("respects depends_on — wave 2 doesn't start until wave 1 completes", async () => {
    const phase = makePhase("p1", [
      makeTask("t1", "Create src/a.ts"),
      makeTask("t2", "Create src/b.ts"),
      makeTask("t3", "Create src/c.ts depending on a and b", {
        depends_on: ["t1", "t2"],
      }),
    ]);
    const stub = stubSubagent({
      t1: [
        {
          diskWrites: [{ rel: "src/a.ts", content: "1" }],
          tool_calls: [fileWriteToolCall("src/a.ts")],
        },
      ],
      t2: [
        {
          diskWrites: [{ rel: "src/b.ts", content: "2" }],
          tool_calls: [fileWriteToolCall("src/b.ts")],
        },
      ],
      t3: [
        {
          diskWrites: [{ rel: "src/c.ts", content: "3" }],
          tool_calls: [fileWriteToolCall("src/c.ts")],
        },
      ],
    });
    const ctx = makeContext(phase);

    await executePhase({ ...ctx, runSubagentImpl: stub.impl });

    expect(phase.tasks.every((t) => t.status === "completed")).toBe(true);
    // Wave order: t1+t2 first (in either order), then t3.
    const calls = stub.taskCalls();
    const t3Idx = calls.indexOf("t3");
    expect(t3Idx).toBe(2);
    expect(calls.slice(0, 2).sort()).toEqual(["t1", "t2"]);
  });

  it("populates the known-files block on subsequent waves", async () => {
    const phase = makePhase("p1", [
      makeTask("t1", "Create src/a.ts"),
      makeTask("t2", "Edit src/a.ts to add a comment", { depends_on: ["t1"] }),
    ]);
    const promptsByTask = new Map<string, string>();
    const stub = stubSubagent({
      t1: [
        {
          diskWrites: [{ rel: "src/a.ts", content: "// initial" }],
          tool_calls: [fileWriteToolCall("src/a.ts")],
        },
      ],
      t2: [
        {
          diskWrites: [{ rel: "src/a.ts", content: "// initial\n// comment" }],
          tool_calls: [
            {
              tool: "file_edit",
              input: JSON.stringify({ path: "src/a.ts" }),
              output: "edited",
              duration: 1,
              success: true,
            },
          ],
        },
      ],
    });
    // Wrap the stub to capture prompts.
    const wrapped: typeof stub.impl = async (callArgs) => {
      const m = callArgs.prompt.match(/^# Task (\S+)/m);
      if (m?.[1]) promptsByTask.set(m[1], callArgs.prompt);
      return stub.impl(callArgs);
    };
    const ctx = makeContext(phase);
    await executePhase({ ...ctx, runSubagentImpl: wrapped });

    // t2's prompt should mention src/a.ts via the known-files block built
    // after t1 completed.
    expect(promptsByTask.get("t2")).toContain("Known files");
    expect(promptsByTask.get("t2")).toContain("src/a.ts");
  });
});

describe("executePhase — error paths", () => {
  it("validator failure on first attempt → retry; second attempt clean → completed", async () => {
    const phase = makePhase("p1", [makeTask("t1", "Create src/foo.ts")]);
    const stub = stubSubagent({
      t1: [
        {
          // First attempt: claims a file but never wrote it → validator fails.
          tool_calls: [fileWriteToolCall("src/foo.ts")],
          summary: "I claim I made it",
        },
        {
          // Second attempt: actually writes.
          diskWrites: [{ rel: "src/foo.ts", content: "ok" }],
          tool_calls: [fileWriteToolCall("src/foo.ts")],
          summary: "Wrote src/foo.ts",
        },
      ],
    });
    const ctx = makeContext(phase);
    await executePhase({ ...ctx, runSubagentImpl: stub.impl });
    expect(phase.tasks[0]?.status).toBe("completed");
    expect(phase.tasks[0]?.retry_count).toBe(1);
    expect(stub.callCount()).toBe(2);
  });

  it("env_command_not_found shell failure → blocked, no retry (PR #77 preserve)", async () => {
    const phase = makePhase("p1", [makeTask("t1", "Run a missing tool")]);
    const stub = stubSubagent({
      t1: [
        {
          tool_calls: [shellFailToolCall("bun: command not found", 127)],
        },
      ],
    });
    const ctx = makeContext(phase);
    await executePhase({ ...ctx, runSubagentImpl: stub.impl });
    expect(phase.tasks[0]?.status).toBe("blocked");
    expect(phase.tasks[0]?.error_kind).toBe("env_command_not_found");
    expect(stub.callCount()).toBe(1);
  });

  it("dependency on a blocked task results in blocked downstream tasks", async () => {
    const phase = makePhase("p1", [
      makeTask("t1", "Run missing build"),
      makeTask("t2", "Edit src/x.ts after build", { depends_on: ["t1"] }),
    ]);
    const stub = stubSubagent({
      t1: [
        {
          tool_calls: [shellFailToolCall("bun: command not found", 127)],
        },
      ],
    });
    const ctx = makeContext(phase);
    await executePhase({ ...ctx, runSubagentImpl: stub.impl });
    expect(phase.tasks[0]?.status).toBe("blocked");
    // t2's deps are terminal → it's "ready", but it has no script so the
    // stub returns a default response without disk writes — and the
    // description "Edit src/x.ts after build" implies write intent so
    // the validator will reject it.
    expect(phase.tasks[1]?.status).not.toBe("pending");
  });
});

describe("executePhase — budget enforcement", () => {
  it("session-budget exhaustion mid-phase ends the phase early", async () => {
    const phase = makePhase("p1", [
      makeTask("t1", "Create src/a.ts"),
      makeTask("t2", "Create src/b.ts", { depends_on: ["t1"] }),
    ]);
    const ctx = makeContext(phase);
    // Session cap big enough that t1's pre-flight estimate passes, but
    // small enough that recording t1's *actual* big consumption flips
    // the session_exhausted flag before t2 starts.
    ctx.budget_tracker = new BudgetTracker({
      max_tokens_per_session: 50_000,
      max_tokens_per_phase: 100_000,
    });
    const stub = stubSubagent({
      t1: [
        {
          diskWrites: [{ rel: "src/a.ts", content: "1" }],
          tool_calls: [fileWriteToolCall("src/a.ts")],
          tokens_breakdown: { input: 25_000, output: 25_000 },
        },
      ],
      t2: [
        {
          diskWrites: [{ rel: "src/b.ts", content: "2" }],
          tool_calls: [fileWriteToolCall("src/b.ts")],
        },
      ],
    });
    const r = await executePhase({ ...ctx, runSubagentImpl: stub.impl });
    expect(r.ended_by).toBe("session_budget");
    expect(phase.tasks[0]?.status).toBe("completed");
    expect(phase.tasks[1]?.status).toBe("blocked");
    expect(phase.tasks[1]?.error).toContain("session_budget_exhausted");
  });

  it("per-task budget rejection blocks the task before LLM call", async () => {
    const tinyTask = makeTask("t1", "Create src/foo.ts");
    tinyTask.max_tokens_per_task = 10; // way too small for the prompt
    const phase = makePhase("p1", [tinyTask]);
    const stub = stubSubagent({});
    const ctx = makeContext(phase);
    const r = await executePhase({ ...ctx, runSubagentImpl: stub.impl });
    expect(r.task_count.blocked).toBe(1);
    expect(phase.tasks[0]?.status).toBe("blocked");
    expect(phase.tasks[0]?.error).toContain("task");
    expect(stub.callCount()).toBe(0); // never called the LLM
  });
});

describe("executePhase — phase time budget", () => {
  it("phase_time_budget_ms expiration aborts in-progress + blocks pending", async () => {
    const phase = makePhase("p1", [
      makeTask("t1", "Create src/a.ts"),
      makeTask("t2", "Create src/b.ts", { depends_on: ["t1"] }),
    ]);
    const ctx = makeContext(phase);
    const stub = stubSubagent({
      t1: [
        {
          // Simulate slow agent — block long enough to outlast the budget.
          diskWrites: [{ rel: "src/a.ts", content: "1" }],
          tool_calls: [fileWriteToolCall("src/a.ts")],
        },
      ],
    });
    // Wrap to delay
    const slowImpl: typeof stub.impl = async (a) => {
      await new Promise((res) => setTimeout(res, 100));
      return stub.impl(a);
    };
    const r = await executePhase({
      ...ctx,
      runSubagentImpl: slowImpl,
      phase_time_budget_ms: 30,
    });
    expect(r.ended_by).toBe("time_budget");
    expect(phase.tasks[1]?.status).toBe("blocked");
    expect(phase.tasks[1]?.error_kind).toBe("timeout");
  });
});
