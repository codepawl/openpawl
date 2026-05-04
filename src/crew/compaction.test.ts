import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ArtifactStore } from "./artifacts/index.js";
import type {
  PhaseSummaryArtifact,
} from "./artifacts/index.js";
import { checkAndCompact } from "./compaction.js";
import { CrewPhaseSchema, CrewTaskSchema, type CrewPhase } from "./types.js";
import { WriteLockManager } from "./write-lock.js";
import type { CrewManifest } from "./manifest/index.js";
import type {
  RunSubagentArgs,
  SubagentResult,
} from "./subagent-runner.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), "openpawl-compact-"));
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
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
        tools: ["file_read", "file_write"],
      },
    ],
  };
}

function makePhase(id: string, taskCount = 1): CrewPhase {
  return CrewPhaseSchema.parse({
    id,
    name: id,
    description: "x",
    complexity_tier: "2",
    status: "completed",
    tasks: Array.from({ length: taskCount }, (_, i) =>
      CrewTaskSchema.parse({
        id: `${id}-t${i + 1}`,
        phase_id: id,
        description: "did the thing",
        assigned_agent: "coder",
        status: "completed",
      }),
    ),
  });
}

function makeStore(): { store: ArtifactStore; locks: WriteLockManager } {
  const locks = new WriteLockManager();
  const store = new ArtifactStore({
    sessionId: "s1",
    homeDir,
    lockManager: locks,
  });
  return { store, locks };
}

function seedSummary(
  store: ArtifactStore,
  phase_id: string,
  payloadOverride: Partial<PhaseSummaryArtifact["payload"]> = {},
): string {
  const id = `summary-${phase_id}`;
  const created_at = 1000 + Number(phase_id.replace(/\D/g, ""));
  store.write(
    {
      id,
      kind: "phase_summary",
      author_agent: "runner",
      phase_id,
      created_at,
      supersedes: null,
      payload: {
        phase_id,
        tasks_completed: 1,
        tasks_failed: 0,
        tasks_blocked: 0,
        files_created: ["src/file.ts"],
        files_modified: [],
        key_decisions: [],
        agent_confidences: {},
        ...payloadOverride,
      },
    },
    "runner",
  );
  return id;
}

function bigSummaryPayload(): Partial<PhaseSummaryArtifact["payload"]> {
  // ~10 KB of repeated text → ~2_500 tokens via the heuristic. With 3+
  // phases this comfortably crosses a 5_000-token threshold.
  const filler = "x".repeat(10_000);
  return {
    files_created: [filler],
  };
}

function compactionStub(
  responses: Record<string, string>,
): {
  impl: (a: RunSubagentArgs) => Promise<SubagentResult>;
  callCount: () => number;
  callsForPhase: (phase_id: string) => number;
} {
  const calls: string[] = [];
  return {
    callCount: () => calls.length,
    callsForPhase: (id) => calls.filter((c) => c.includes(id)).length,
    impl: async (callArgs) => {
      const m = callArgs.prompt.match(/phase\s+'([^']+)'\s+\(([^)]+)\)/);
      const phase_id = m?.[2] ?? "unknown";
      calls.push(phase_id);
      const text = responses[phase_id] ?? `## Phase ${phase_id} compacted\n- one bullet`;
      return {
        summary: text,
        produced_artifacts: [],
        tokens_used: 200,
        tokens_breakdown: { input: 100, output: 100 },
      };
    },
  };
}

describe("checkAndCompact — threshold gating", () => {
  it("does nothing when token estimate is below threshold", async () => {
    const { store, locks } = makeStore();
    seedSummary(store, "p1");
    seedSummary(store, "p2");
    seedSummary(store, "p3");

    const r = await checkAndCompact({
      phases: [makePhase("p1"), makePhase("p2"), makePhase("p3")],
      manifest: manifest(),
      artifact_store: store,
      write_lock_manager: locks,
      session_id: "s1",
      model_context_window: 1_000_000,
      threshold_ratio: 0.8,
      runSubagentImpl: compactionStub({}).impl,
    });

    expect(r.triggered).toBe(false);
    expect(r.compacted_phases).toEqual([]);
    expect(store.list({ kind: "phase_compaction" })).toHaveLength(0);
  });

  it("fires compaction across earlier phases when threshold crossed; preserves the most recent", async () => {
    const { store, locks } = makeStore();
    seedSummary(store, "p1", bigSummaryPayload());
    seedSummary(store, "p2", bigSummaryPayload());
    seedSummary(store, "p3", bigSummaryPayload());
    seedSummary(store, "p4", bigSummaryPayload());

    const stub = compactionStub({
      p1: "## p1 compact\n- t1 done, file.ts written",
      p2: "## p2 compact\n- t1 done, decision X",
      p3: "## p3 compact\n- t1 done",
    });
    const r = await checkAndCompact({
      phases: [
        makePhase("p1"),
        makePhase("p2"),
        makePhase("p3"),
        makePhase("p4"),
      ],
      manifest: manifest(),
      artifact_store: store,
      write_lock_manager: locks,
      session_id: "s1",
      model_context_window: 5_000, // tiny so threshold is reached
      threshold_ratio: 0.5,
      runSubagentImpl: stub.impl,
    });

    expect(r.triggered).toBe(true);
    // p1, p2, p3 compacted. p4 (most recent completed) preserved.
    expect(r.compacted_phases.map((c) => c.phase_id).sort()).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    const compactions = store.list({ kind: "phase_compaction" });
    expect(compactions).toHaveLength(3);
    // p4 is NOT in the list.
    expect(compactions.every((c) => c.phase_id !== "p4")).toBe(true);
    expect(stub.callsForPhase("p4")).toBe(0);
  });

  it("idempotent: a second call skips already-compacted phases", async () => {
    const { store, locks } = makeStore();
    seedSummary(store, "p1", bigSummaryPayload());
    seedSummary(store, "p2", bigSummaryPayload());
    seedSummary(store, "p3", bigSummaryPayload());

    const stub = compactionStub({});
    const args = {
      phases: [makePhase("p1"), makePhase("p2"), makePhase("p3")],
      manifest: manifest(),
      artifact_store: store,
      write_lock_manager: locks,
      session_id: "s1",
      model_context_window: 5_000,
      threshold_ratio: 0.5,
      runSubagentImpl: stub.impl,
    };
    await checkAndCompact(args);
    const callsAfterFirst = stub.callCount();
    expect(callsAfterFirst).toBeGreaterThan(0);

    const r2 = await checkAndCompact(args);
    // Second call: every prior compaction target should be skipped with
    // already_compacted reason.
    expect(r2.compacted_phases).toEqual([]);
    expect(r2.skipped_phases.some((s) => s.reason === "already_compacted")).toBe(true);
    // Stub was not called again.
    expect(stub.callCount()).toBe(callsAfterFirst);
  });
});

describe("checkAndCompact — defensive paths", () => {
  it("subagent failure on one phase logs + skips, run continues for others", async () => {
    const { store, locks } = makeStore();
    seedSummary(store, "p1", bigSummaryPayload());
    seedSummary(store, "p2", bigSummaryPayload());
    seedSummary(store, "p3", bigSummaryPayload());

    let calls = 0;
    const flakyImpl = async (a: RunSubagentArgs): Promise<SubagentResult> => {
      calls += 1;
      if (calls === 1) throw new Error("first compaction crashed");
      return {
        summary: `## Phase ${a.prompt.match(/\((p\d+)\)/)?.[1] ?? "x"} compact\n- bullet`,
        produced_artifacts: [],
        tokens_used: 100,
        tokens_breakdown: { input: 50, output: 50 },
      };
    };

    const r = await checkAndCompact({
      phases: [makePhase("p1"), makePhase("p2"), makePhase("p3")],
      manifest: manifest(),
      artifact_store: store,
      write_lock_manager: locks,
      session_id: "s1",
      model_context_window: 5_000,
      threshold_ratio: 0.5,
      runSubagentImpl: flakyImpl,
    });

    expect(r.triggered).toBe(true);
    // Two phases targeted (p1, p2 — p3 most recent preserved). One failed,
    // one succeeded.
    expect(r.compacted_phases).toHaveLength(1);
    expect(r.skipped_phases.some((s) => s.reason === "subagent_failed")).toBe(true);
  });

  it("manifest with no planner agent → all targets skipped with no_facilitator_agent", async () => {
    const { store, locks } = makeStore();
    seedSummary(store, "p1", bigSummaryPayload());
    seedSummary(store, "p2", bigSummaryPayload());
    seedSummary(store, "p3", bigSummaryPayload());

    const m = manifest();
    m.agents = m.agents.filter((a) => a.id !== "planner");

    const r = await checkAndCompact({
      phases: [makePhase("p1"), makePhase("p2"), makePhase("p3")],
      manifest: m,
      artifact_store: store,
      write_lock_manager: locks,
      session_id: "s1",
      model_context_window: 5_000,
      threshold_ratio: 0.5,
      runSubagentImpl: compactionStub({}).impl,
    });
    expect(r.triggered).toBe(true);
    expect(r.compacted_phases).toEqual([]);
    expect(r.skipped_phases.every((s) => s.reason === "no_facilitator_agent")).toBe(true);
  });

  it("only one completed phase → no compaction (recency preserved)", async () => {
    const { store, locks } = makeStore();
    seedSummary(store, "p1", bigSummaryPayload());

    const r = await checkAndCompact({
      phases: [makePhase("p1")],
      manifest: manifest(),
      artifact_store: store,
      write_lock_manager: locks,
      session_id: "s1",
      model_context_window: 1_000,
      threshold_ratio: 0.1,
      runSubagentImpl: compactionStub({}).impl,
    });
    expect(r.triggered).toBe(true);
    expect(r.compacted_phases).toEqual([]);
    expect(r.skipped_phases[0]?.reason).toBe("only_one_completed_phase");
  });
});
