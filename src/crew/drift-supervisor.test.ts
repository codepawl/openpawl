import { describe, expect, it } from "bun:test";

import {
  DEFAULT_DRIFT_HALT_THRESHOLD,
  DEFAULT_DRIFT_WARN_THRESHOLD,
  checkDriftAtPhaseBoundary,
  defaultDriftScorer,
} from "./drift-supervisor.js";
import type { PhaseSummaryArtifact } from "./artifacts/index.js";

const ON_TOPIC_MARKDOWN = `## Phase p1 retrospective

### What we achieved
- Added the /health endpoint with fastify route and handler in src/health.ts
- Tests for the health endpoint pass

### What we're debating
- Whether to add Prometheus metrics for the health endpoint now or in a follow-up

### Missing perspective
- Latency budget for the new health endpoint

### Proposed next phase
- Write integration tests for the health endpoint coverage
`;

const FAR_DRIFT_MARKDOWN = `## Phase p1 retrospective

### What we achieved
- Refactored billing module into a microservices architecture
- Migrated user accounts from MySQL to PostgreSQL
- Set up new Kubernetes deployment manifests for staging cluster

### What we're debating
- Whether GraphQL or gRPC for inter-service communication

### Missing perspective
- Cache invalidation strategy

### Proposed next phase
- Wire OAuth2 PKCE flow into the new auth microservice
- Design queue topology for invoice rendering
`;

function summary(
  phase_id: string,
  key_decisions: string[],
): PhaseSummaryArtifact {
  return {
    id: `summary-${phase_id}`,
    kind: "phase_summary",
    author_agent: "runner",
    phase_id,
    created_at: 1,
    supersedes: null,
    payload: {
      phase_id,
      tasks_completed: 1,
      tasks_failed: 0,
      tasks_blocked: 0,
      files_created: [],
      files_modified: [],
      key_decisions,
      agent_confidences: {},
    },
  };
}

describe("defaultDriftScorer", () => {
  it("returns 0 for identical strings", () => {
    expect(defaultDriftScorer("add health endpoint", "add health endpoint")).toBe(0);
  });

  it("returns close to 1 for completely different content", () => {
    const score = defaultDriftScorer(
      "add health endpoint",
      "refactor billing service into microservices",
    );
    expect(score).toBeGreaterThan(0.9);
  });

  it("clamps to [0, 1]", () => {
    const score = defaultDriftScorer("hello", "hello world world world");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns 1 for empty input on either side", () => {
    expect(defaultDriftScorer("", "anything")).toBe(1);
    expect(defaultDriftScorer("anything", "")).toBe(1);
  });
});

describe("checkDriftAtPhaseBoundary — decision buckets", () => {
  it("on-topic markdown → ok", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "Add a /health endpoint to the fastify server with tests and metrics",
      meeting_notes_markdown: ON_TOPIC_MARKDOWN,
      prev_phase_id: "p1",
    });
    expect(r.decision).toBe("ok");
    expect(r.score).toBeLessThan(DEFAULT_DRIFT_WARN_THRESHOLD);
    expect(r.drifting_decisions).toEqual([]);
  });

  it("far-drift markdown → halt", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "Add a /health endpoint",
      meeting_notes_markdown: FAR_DRIFT_MARKDOWN,
      prev_phase_id: "p1",
    });
    expect(r.decision).toBe("halt");
    expect(r.score).toBeGreaterThanOrEqual(DEFAULT_DRIFT_HALT_THRESHOLD);
  });

  it("respects custom thresholds", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "alpha beta gamma",
      meeting_notes_markdown: "alpha beta delta epsilon zeta",
      prev_phase_id: "p1",
      drift_warn_threshold: 0.3,
      drift_halt_threshold: 0.5,
    });
    expect(r.decision).toBe("warn");
  });

  it("threshold edge — score exactly at warn → warn", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "y",
      prev_phase_id: "p1",
      scorer: () => 0.5, // exactly at default warn threshold
    });
    expect(r.decision).toBe("warn");
  });

  it("threshold edge — score exactly at halt → halt", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "y",
      prev_phase_id: "p1",
      scorer: () => 0.75, // exactly at default halt threshold
    });
    expect(r.decision).toBe("halt");
  });
});

describe("checkDriftAtPhaseBoundary — drifting_decisions", () => {
  it("populates drifting_decisions on warn from recent_phase_summaries", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "Add a /health endpoint",
      meeting_notes_markdown: "decided to refactor everything into microservices",
      prev_phase_id: "p2",
      recent_phase_summaries: [
        summary("p2", [
          "Refactor billing into microservices",
          "Migrate to Kubernetes for the new architecture",
        ]),
        summary("p1", ["Add /health endpoint to fastify"]),
      ],
    });
    expect(r.decision === "warn" || r.decision === "halt").toBe(true);
    expect(r.drifting_decisions.length).toBeGreaterThan(0);
    expect(r.drifting_decisions[0]?.drift_distance).toBeGreaterThan(
      r.drifting_decisions[r.drifting_decisions.length - 1]!.drift_distance - 0.001,
    );
  });

  it("returns at most 3 drifting decisions", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "y completely unrelated content",
      prev_phase_id: "p2",
      recent_phase_summaries: [
        summary("p2", ["d1", "d2", "d3", "d4"]),
        summary("p1", ["d5", "d6", "d7"]),
      ],
    });
    expect(r.drifting_decisions.length).toBeLessThanOrEqual(3);
  });

  it("empty key_decisions → empty drifting_decisions even on halt", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "completely different content",
      prev_phase_id: "p2",
      recent_phase_summaries: [summary("p2", []), summary("p1", [])],
    });
    expect(r.drifting_decisions).toEqual([]);
  });
});

describe("checkDriftAtPhaseBoundary — defensive degradation", () => {
  it("scorer throwing → returns ok with score 0", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "y",
      prev_phase_id: "p1",
      scorer: () => {
        throw new Error("scorer crashed");
      },
    });
    expect(r.decision).toBe("ok");
    expect(r.score).toBe(0);
    expect(r.drifting_decisions).toEqual([]);
  });

  it("scorer returning NaN → clamped to 0, decision ok", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "y",
      prev_phase_id: "p1",
      scorer: () => Number.NaN,
    });
    expect(r.decision).toBe("ok");
    expect(r.score).toBe(0);
  });

  it("scorer returning > 1 → clamped to 1 → halt", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "y",
      prev_phase_id: "p1",
      scorer: () => 5,
    });
    expect(r.score).toBe(1);
    expect(r.decision).toBe("halt");
  });

  it("scorer returning < 0 → clamped to 0 → ok", () => {
    const r = checkDriftAtPhaseBoundary({
      goal: "x",
      meeting_notes_markdown: "y",
      prev_phase_id: "p1",
      scorer: () => -1,
    });
    expect(r.score).toBe(0);
    expect(r.decision).toBe("ok");
  });
});
