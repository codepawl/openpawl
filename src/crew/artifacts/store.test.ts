import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WriteLockManager } from "../write-lock.js";
import { ArtifactStore, artifactJsonlPath } from "./store.js";
import type {
  PlanArtifact,
  ReviewArtifact,
  ReflectionArtifact,
} from "./types.js";

let homeDir: string;
const SESSION_ID = "test-session";

function makeStore(): { store: ArtifactStore; locks: WriteLockManager } {
  const locks = new WriteLockManager();
  const store = new ArtifactStore({
    sessionId: SESSION_ID,
    homeDir,
    lockManager: locks,
  });
  return { store, locks };
}

function planArtifact(id: string, overrides: Partial<PlanArtifact> = {}): PlanArtifact {
  return {
    id,
    kind: "plan",
    author_agent: "planner",
    phase_id: null,
    created_at: 1700000000000,
    supersedes: null,
    payload: {
      phases: [{ id: "p1", name: "Scaffold", complexity_tier: "1" }],
      tasks: [
        {
          id: "t1",
          phase_id: "p1",
          assigned_agent: "coder",
          depends_on: [],
        },
      ],
      rationale: "Build the thing in one phase.",
    },
    ...overrides,
  };
}

function reviewArtifact(id: string, phaseId: string): ReviewArtifact {
  return {
    id,
    kind: "review",
    author_agent: "reviewer",
    phase_id: phaseId,
    created_at: 1700000000000,
    supersedes: null,
    payload: {
      target_files: ["src/foo.ts"],
      findings: [
        {
          severity: "warn",
          file: "src/foo.ts",
          line: 12,
          message: "Avoid `any`",
          suggestion: "Type as `unknown` and narrow",
        },
      ],
      verdict: "request_changes",
      summary: "One typing issue.",
    },
  };
}

function reflectionArtifact(id: string, agentId: string): ReflectionArtifact {
  return {
    id,
    kind: "reflection",
    author_agent: agentId,
    phase_id: "p1",
    created_at: 1700000000001,
    supersedes: null,
    payload: {
      phase_id: "p1",
      agent_id: agentId,
      went_well: ["Tests passed"],
      went_poorly: [],
      next_phase_focus: ["Refactor"],
      confidence: 80,
      round: 1,
    },
  };
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), "openpawl-artifact-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("ArtifactStore", () => {
  it("write + read roundtrips and persists to JSONL", () => {
    const { store } = makeStore();

    const result = store.write(planArtifact("a1"), "planner");
    expect(result.written).toBe(true);

    const loaded = store.read("a1");
    expect(loaded?.kind).toBe("plan");
    expect(loaded?.author_agent).toBe("planner");

    const jsonlPath = artifactJsonlPath(SESSION_ID, homeDir);
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).id).toBe("a1");
  });

  it("list filters by kind and phase_id", () => {
    const { store } = makeStore();
    store.write(planArtifact("plan1"), "planner");
    store.write(reviewArtifact("rev1", "p1"), "reviewer");
    store.write(reviewArtifact("rev2", "p2"), "reviewer");
    store.write(reflectionArtifact("ref1", "coder"), "coder");

    expect(store.list().length).toBe(4);
    expect(store.list({ kind: "review" }).map((a) => a.id).sort()).toEqual([
      "rev1",
      "rev2",
    ]);
    expect(store.list({ phase_id: "p1" }).map((a) => a.id).sort()).toEqual([
      "ref1",
      "rev1",
    ]);
    expect(store.list({ kind: "review", phase_id: "p2" }).map((a) => a.id)).toEqual([
      "rev2",
    ]);
    expect(store.list({ phase_id: null }).map((a) => a.id)).toEqual(["plan1"]);
  });

  it("supersession chain: new artifact references the old; both stored", () => {
    const { store } = makeStore();
    store.write(planArtifact("plan1"), "planner");

    const v2 = planArtifact("plan2", {
      payload: {
        phases: [
          { id: "p1", name: "Scaffold (revised)", complexity_tier: "2" },
        ],
        tasks: [
          { id: "t1", phase_id: "p1", assigned_agent: "coder", depends_on: [] },
          { id: "t2", phase_id: "p1", assigned_agent: "tester", depends_on: ["t1"] },
        ],
        rationale: "Revised: add lint step.",
      },
    });
    const result = store.supersede("plan1", v2, "planner");
    expect(result.written).toBe(true);

    const newer = store.read("plan2");
    expect(newer?.supersedes).toBe("plan1");
    expect(store.read("plan1")).not.toBeNull();
    expect(store.list({ kind: "plan" }).length).toBe(2);
  });

  it("supersede with unknown predecessor returns no_such_predecessor", () => {
    const { store } = makeStore();
    const result = store.supersede("missing", planArtifact("p2"), "planner");
    expect(result.written).toBe(false);
    if (!result.written) {
      expect(result.reason).toBe("no_such_predecessor");
    }
  });

  it("rejects a write while another agent holds the artifact lock", async () => {
    const { store, locks } = makeStore();
    const lockKey = `artifact:${SESSION_ID}`;

    await locks.acquire(lockKey, "reviewer");
    try {
      const result = store.write(planArtifact("a1"), "planner");
      expect(result.written).toBe(false);
      if (!result.written) {
        expect(result.reason).toBe("lock_denied");
        expect(result.holder_agent).toBe("reviewer");
      }
      // Same agent that holds the lock can write through.
      const okResult = store.write(planArtifact("a2"), "reviewer");
      expect(okResult.written).toBe(true);
    } finally {
      locks.release(lockKey, "reviewer");
    }
  });

  it("rejects duplicate id", () => {
    const { store } = makeStore();
    expect(store.write(planArtifact("a1"), "planner").written).toBe(true);
    const dup = store.write(planArtifact("a1"), "planner");
    expect(dup.written).toBe(false);
    if (!dup.written) expect(dup.reason).toBe("duplicate_id");
  });

  it("rejects malformed payload with validation_failed", () => {
    const { store } = makeStore();
    const bad = {
      id: "bad",
      kind: "plan",
      author_agent: "planner",
      phase_id: null,
      created_at: 1,
      supersedes: null,
      payload: { phases: [], tasks: [], rationale: "" },
    } as unknown as PlanArtifact;
    const r = store.write(bad, "planner");
    expect(r.written).toBe(false);
    if (!r.written) expect(r.reason).toBe("validation_failed");
  });

  it("JSONL persists across reload (new store reads existing file)", () => {
    {
      const { store } = makeStore();
      store.write(planArtifact("a1"), "planner");
      store.write(reviewArtifact("r1", "p1"), "reviewer");
    }
    {
      const { store } = makeStore();
      expect(store.read("a1")?.kind).toBe("plan");
      expect(store.read("r1")?.kind).toBe("review");
      expect(store.list().length).toBe(2);
    }
  });

  it("reader() view exposes only read/list", () => {
    const { store } = makeStore();
    store.write(planArtifact("a1"), "planner");
    const r = store.reader();
    expect(r.read("a1")?.id).toBe("a1");
    expect(r.list().length).toBe(1);
    expect(Object.keys(r).sort()).toEqual(["list", "read"]);
  });
});
