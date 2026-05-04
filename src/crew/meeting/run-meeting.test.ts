import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ArtifactStore } from "../artifacts/index.js";
import { runDiscussionMeeting } from "./run-meeting.js";
import { CrewPhaseSchema, CrewTaskSchema, type CrewPhase } from "../types.js";
import { WriteLockManager } from "../write-lock.js";
import type { CrewManifest } from "../manifest/index.js";
import type {
  RunSubagentArgs,
  SubagentResult,
} from "../subagent-runner.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), "openpawl-meeting-"));
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function fullStackManifest(): CrewManifest {
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
      {
        id: "reviewer",
        name: "Reviewer",
        description: "x",
        prompt: "Reviewer prompt.",
        tools: ["file_read"],
      },
      {
        id: "tester",
        name: "Tester",
        description: "x",
        prompt: "Tester prompt.",
        tools: ["file_read", "file_write"],
        write_scope: ["**/*.test.ts"],
      },
    ],
  };
}

function makePhase(id: string, tier: "1" | "2" | "3"): CrewPhase {
  return CrewPhaseSchema.parse({
    id,
    name: id,
    description: "x",
    complexity_tier: tier,
    tasks: [
      CrewTaskSchema.parse({
        id: `${id}-t1`,
        phase_id: id,
        description: "did the thing",
        assigned_agent: "coder",
        status: "completed",
        files_created: [`src/${id}.ts`],
      }),
    ],
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

const HAPPY_REFLECTION = JSON.stringify({
  went_well: ["t1 finished", "tests passed first try"],
  went_poorly: ["one retry on the route"],
  next_phase_focus: ["lift coverage further"],
  confidence: 75,
});

const HAPPY_FACILITATOR_MARKDOWN = `## Phase p1 retrospective

### What we achieved
- t1 finished cleanly across the crew.

### What we're debating
- whether to lift coverage now or defer.

### Missing perspective
- nobody examined latency.

### Proposed next phase
- write integration tests for the new endpoint
- add a metric exporter
`;

interface StubScript {
  /** Map agent_id → ordered LLM responses for that agent. The runner pops one per call. */
  byAgent?: Record<string, string[]>;
  /** Default response for unscripted agents. */
  default?: string;
  /** Throw on this agent's first call (Promise.allSettled smoke). */
  throwOn?: { agent_id: string; round: 1 | 2 };
}

function stubSubagent(script: StubScript): {
  impl: (args: RunSubagentArgs) => Promise<SubagentResult>;
  callsByAgent: () => Record<string, number>;
  capturedPrompts: () => Array<{ agent_id: string; prompt: string }>;
} {
  const counters = new Map<string, number>();
  const captured: Array<{ agent_id: string; prompt: string }> = [];
  return {
    callsByAgent: () => Object.fromEntries(counters),
    capturedPrompts: () => captured,
    impl: async (callArgs) => {
      const agent_id = callArgs.agent_def.id;
      const idx = counters.get(agent_id) ?? 0;
      counters.set(agent_id, idx + 1);
      captured.push({ agent_id, prompt: callArgs.prompt });

      if (
        script.throwOn &&
        agent_id === script.throwOn.agent_id &&
        idx + 1 === 1
      ) {
        throw new Error("simulated explorer crash");
      }

      const list = script.byAgent?.[agent_id] ?? [];
      const response =
        list[Math.min(idx, list.length - 1)] ?? script.default ?? "";

      return {
        summary: response,
        produced_artifacts: [],
        tokens_used: 200,
        tokens_breakdown: { input: 100, output: 100 },
      };
    },
  };
}

function makeArgs(opts: {
  prev_phase: CrewPhase | undefined;
  next_phase: CrewPhase | undefined;
  store: ArtifactStore;
  locks: WriteLockManager;
  runSubagentImpl: (a: RunSubagentArgs) => Promise<SubagentResult>;
}) {
  return {
    prev_phase: opts.prev_phase,
    next_phase: opts.next_phase,
    manifest: fullStackManifest(),
    goal: "Add a /health endpoint",
    artifact_store: opts.store,
    write_lock_manager: opts.locks,
    session_id: "s1",
    runSubagentImpl: opts.runSubagentImpl,
  };
}

describe("runDiscussionMeeting — skip conditions", () => {
  it("skips on first phase boundary (prev_phase undefined)", async () => {
    const { store, locks } = makeStore();
    const stub = stubSubagent({});
    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: undefined,
        next_phase: makePhase("p2", "2"),
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );
    expect(r.skipped_reason).toBe("first_phase_boundary");
    expect(r.meeting_notes_artifact_id).toBeNull();
    expect(store.list().length).toBe(0);
  });

  it("skips on last phase (next_phase undefined)", async () => {
    const { store, locks } = makeStore();
    const stub = stubSubagent({});
    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: makePhase("p1", "2"),
        next_phase: undefined,
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );
    expect(r.skipped_reason).toBe("last_phase");
    expect(store.list().length).toBe(0);
  });

  it("skips Tier 1 phase", async () => {
    const { store, locks } = makeStore();
    const stub = stubSubagent({});
    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: makePhase("p1", "1"),
        next_phase: makePhase("p2", "2"),
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );
    expect(r.skipped_reason).toBe("tier_1");
    expect(store.list({ kind: "meeting_notes" }).length).toBe(0);
  });
});

describe("runDiscussionMeeting — Tier 2 happy path", () => {
  it("produces 1 MeetingNotesArtifact + 1 ReflectionArtifact per non-planner agent (round=1)", async () => {
    const { store, locks } = makeStore();
    // Distinct reflections per agent so sycophancy detector doesn't flag.
    const stub = stubSubagent({
      byAgent: {
        coder: [JSON.stringify({
          went_well: ["coder unique alpha", "coder unique beta"],
          went_poorly: ["coder unique gamma"],
          next_phase_focus: ["coder direction"],
          confidence: 75,
        })],
        reviewer: [JSON.stringify({
          went_well: ["reviewer specific delta", "reviewer specific epsilon"],
          went_poorly: ["reviewer specific zeta"],
          next_phase_focus: ["reviewer direction"],
          confidence: 70,
        })],
        tester: [JSON.stringify({
          went_well: ["tester observation eta", "tester observation theta"],
          went_poorly: ["tester observation iota"],
          next_phase_focus: ["tester direction"],
          confidence: 80,
        })],
        planner: [HAPPY_FACILITATOR_MARKDOWN],
      },
    });

    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: makePhase("p1", "2"),
        next_phase: makePhase("p2", "2"),
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );

    expect(r.skipped_reason).toBeNull();
    if (r.skipped_reason !== null) return;

    expect(r.rounds_run).toBe(1);
    expect(r.sycophancy_flagged).toBe(false);
    expect(r.reflection_artifact_ids.length).toBe(3); // coder + reviewer + tester (planner excluded)

    const reflections = store.list({ kind: "reflection" });
    expect(reflections).toHaveLength(3);
    expect(reflections.every((a) => a.kind === "reflection" && a.payload.round === 1)).toBe(true);

    const meetings = store.list({ kind: "meeting_notes" });
    expect(meetings).toHaveLength(1);
    if (meetings[0]?.kind === "meeting_notes") {
      expect(meetings[0].payload.tier).toBe("2");
      expect(meetings[0].payload.rounds_run).toBe(1);
      expect(meetings[0].payload.next_phase_id).toBe("p2");
      expect(meetings[0].payload.markdown).toContain("Proposed next phase");
    }
  });
});

describe("runDiscussionMeeting — Tier 3 RA-CR", () => {
  it("runs two rounds — produces 2 reflections per agent + rounds_run=2", async () => {
    const { store, locks } = makeStore();
    // coder/reviewer/tester each respond with HAPPY_REFLECTION on every call
    // (rounds 1 + 2). Planner facilitates with HAPPY_FACILITATOR_MARKDOWN.
    // To avoid sycophancy collisions on round 1, vary the went_well content slightly per agent.
    const reflectionCoder = JSON.stringify({
      went_well: ["coder uniquely observed the route handler latency"],
      went_poorly: ["one retry was needed on the route handler"],
      next_phase_focus: ["lift integration coverage"],
      confidence: 70,
    });
    const reflectionReviewer = JSON.stringify({
      went_well: ["reviewer noted the typing surface looked clean overall"],
      went_poorly: ["reviewer caught a missing type assertion"],
      next_phase_focus: ["audit the new endpoint's error paths"],
      confidence: 65,
    });
    const reflectionTester = JSON.stringify({
      went_well: ["tester confirmed every existing fixture still passes"],
      went_poorly: ["tester sees thin coverage on the edge cases"],
      next_phase_focus: ["add boundary cases to the test suite"],
      confidence: 80,
    });
    const stub = stubSubagent({
      byAgent: {
        coder: [reflectionCoder, reflectionCoder],
        reviewer: [reflectionReviewer, reflectionReviewer],
        tester: [reflectionTester, reflectionTester],
        planner: [HAPPY_FACILITATOR_MARKDOWN],
      },
    });

    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: makePhase("p1", "3"),
        next_phase: makePhase("p2", "2"),
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );

    expect(r.skipped_reason).toBeNull();
    if (r.skipped_reason !== null) return;
    expect(r.rounds_run).toBe(2);

    const reflections = store.list({ kind: "reflection" });
    expect(reflections.length).toBe(6); // 3 agents × 2 rounds
    const round1Count = reflections.filter(
      (a) => a.kind === "reflection" && a.payload.round === 1,
    ).length;
    const round2Count = reflections.filter(
      (a) => a.kind === "reflection" && a.payload.round === 2,
    ).length;
    expect(round1Count).toBe(3);
    expect(round2Count).toBe(3);

    const meetings = store.list({ kind: "meeting_notes" });
    expect(meetings).toHaveLength(1);
    if (meetings[0]?.kind === "meeting_notes") {
      expect(meetings[0].payload.rounds_run).toBe(2);
      expect(meetings[0].payload.tier).toBe("3");
    }
  });
});

describe("runDiscussionMeeting — sycophancy", () => {
  it("flags identical reflections from multiple agents and re-prompts duplicates", async () => {
    const { store, locks } = makeStore();
    // All three Explorers return THE SAME reflection on first call → sycophancy.
    // On the retry, return distinct content so the meeting completes.
    const distinctCoder = JSON.stringify({
      went_well: ["coder distinct content on retry observation one"],
      went_poorly: ["coder distinct concern on retry topic two"],
      next_phase_focus: ["coder unique direction"],
      confidence: 60,
    });
    const distinctReviewer = JSON.stringify({
      went_well: ["reviewer distinct content on retry observation alpha"],
      went_poorly: ["reviewer distinct concern on retry topic beta"],
      next_phase_focus: ["reviewer unique direction"],
      confidence: 55,
    });
    const stub = stubSubagent({
      byAgent: {
        coder: [HAPPY_REFLECTION, distinctCoder],
        reviewer: [HAPPY_REFLECTION, distinctReviewer],
        tester: [HAPPY_REFLECTION, JSON.stringify({
          went_well: ["tester distinct retry"],
          went_poorly: ["tester different concern"],
          next_phase_focus: ["tester next"],
          confidence: 70,
        })],
        planner: [HAPPY_FACILITATOR_MARKDOWN],
      },
    });

    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: makePhase("p1", "2"),
        next_phase: makePhase("p2", "2"),
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );

    expect(r.skipped_reason).toBeNull();
    if (r.skipped_reason !== null) return;
    expect(r.sycophancy_flagged).toBe(true);

    // Each Explorer was called twice (initial + anti-sycophancy retry).
    const calls = stub.callsByAgent();
    expect(calls.coder).toBe(2);
    expect(calls.reviewer).toBe(2);
    expect(calls.tester).toBe(2);
  });
});

describe("runDiscussionMeeting — facilitator fallback", () => {
  it("when Facilitator output fails parse twice, falls back to deterministic template", async () => {
    const { store, locks } = makeStore();
    const stub = stubSubagent({
      default: HAPPY_REFLECTION,
      byAgent: {
        planner: [
          // First attempt: missing 'Proposed next phase' header → too_short OR missing_proposal_section.
          "## Some short thing\n\nnot what we want",
          // Second attempt: also missing → fallback used.
          "## Still short",
        ],
      },
    });

    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: makePhase("p1", "2"),
        next_phase: makePhase("p2", "2"),
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );

    expect(r.skipped_reason).toBeNull();
    if (r.skipped_reason !== null) return;

    const meetings = store.list({ kind: "meeting_notes" });
    expect(meetings).toHaveLength(1);
    if (meetings[0]?.kind === "meeting_notes") {
      expect(meetings[0].payload.markdown).toContain(
        "Auto-generated fallback summary",
      );
      expect(meetings[0].payload.markdown).toContain("Proposed next phase");
    }
  });
});

describe("runDiscussionMeeting — Promise.allSettled robustness", () => {
  it("one Explorer crashing does not abort the meeting; counts as rejected", async () => {
    const { store, locks } = makeStore();
    const distinctReviewer = JSON.stringify({
      went_well: ["reviewer alpha"],
      went_poorly: ["reviewer beta"],
      next_phase_focus: ["reviewer gamma"],
      confidence: 50,
    });
    const distinctTester = JSON.stringify({
      went_well: ["tester delta"],
      went_poorly: ["tester epsilon"],
      next_phase_focus: ["tester zeta"],
      confidence: 60,
    });
    const stub = stubSubagent({
      byAgent: {
        reviewer: [distinctReviewer],
        tester: [distinctTester],
        planner: [HAPPY_FACILITATOR_MARKDOWN],
      },
      throwOn: { agent_id: "coder", round: 1 },
    });

    const r = await runDiscussionMeeting(
      makeArgs({
        prev_phase: makePhase("p1", "2"),
        next_phase: makePhase("p2", "2"),
        store,
        locks,
        runSubagentImpl: stub.impl,
      }),
    );

    expect(r.skipped_reason).toBeNull();
    if (r.skipped_reason !== null) return;
    expect(r.rejected_reflection_count).toBeGreaterThanOrEqual(1);
    // Meeting still produced its artifacts.
    expect(store.list({ kind: "meeting_notes" })).toHaveLength(1);
    expect(store.list({ kind: "reflection" }).length).toBeGreaterThanOrEqual(2);
  });
});
