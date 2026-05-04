import { describe, expect, it } from "bun:test";

import {
  REANCHOR_OPTIONS,
  buildReanchorPrompt,
} from "./drift-reanchor.js";
import type { DriftingDecision } from "./drift-supervisor.js";

function decision(
  description: string,
  phase_id: string,
  distance: number,
): DriftingDecision {
  return { description, decided_in_phase_id: phase_id, drift_distance: distance };
}

describe("buildReanchorPrompt", () => {
  it("renders the original goal verbatim", () => {
    const r = buildReanchorPrompt({
      original_goal: "Add a /health endpoint to fastify with tests",
      drifting_decisions: [],
      current_phase: { id: "p2", name: "Refactor" },
      drift_score: 0.85,
    });
    expect(r.markdown).toContain("Add a /health endpoint to fastify with tests");
  });

  it("preserves multi-line goals as blockquotes", () => {
    const r = buildReanchorPrompt({
      original_goal: "Line 1\nLine 2\nLine 3",
      drifting_decisions: [],
      current_phase: { id: "p1", name: "Phase 1" },
      drift_score: 0.8,
    });
    expect(r.markdown).toContain("> Line 1\n> Line 2\n> Line 3");
  });

  it("renders all (up to 3) drifting decisions with phase id + drift %", () => {
    const r = buildReanchorPrompt({
      original_goal: "x",
      drifting_decisions: [
        decision("Refactor billing into microservices", "p2", 0.92),
        decision("Migrate to Kubernetes", "p2", 0.88),
        decision("Add Prometheus exporter", "p1", 0.71),
        decision("Drop column foo", "p0", 0.6),
      ],
      current_phase: { id: "p3", name: "Phase 3" },
      drift_score: 0.85,
    });
    expect(r.markdown).toContain("Refactor billing into microservices");
    expect(r.markdown).toContain("Migrate to Kubernetes");
    expect(r.markdown).toContain("Add Prometheus exporter");
    // Caps at 3
    expect(r.markdown).not.toContain("Drop column foo");
    expect(r.markdown).toContain("p2");
    expect(r.markdown).toContain("92%");
  });

  it("renders the no-decisions fallback when drifting_decisions is empty", () => {
    const r = buildReanchorPrompt({
      original_goal: "x",
      drifting_decisions: [],
      current_phase: { id: "p1", name: "Phase 1" },
      drift_score: 0.85,
    });
    expect(r.markdown).toContain("no drifting decisions surfaced");
  });

  it("options array contains continue / abort / edit_goal", () => {
    const r = buildReanchorPrompt({
      original_goal: "x",
      drifting_decisions: [],
      current_phase: { id: "p1", name: "Phase 1" },
      drift_score: 0.85,
    });
    expect(r.options).toEqual(REANCHOR_OPTIONS);
    expect(r.options).toContain("continue");
    expect(r.options).toContain("abort");
    expect(r.options).toContain("edit_goal");
  });

  it("drift_score is rendered as a percentage in the header", () => {
    const r = buildReanchorPrompt({
      original_goal: "x",
      drifting_decisions: [],
      current_phase: { id: "p1", name: "Phase 1" },
      drift_score: 0.825,
    });
    expect(r.markdown).toMatch(/82(\.5)?%|83%/);
  });

  it("current phase name + id surfaced", () => {
    const r = buildReanchorPrompt({
      original_goal: "x",
      drifting_decisions: [],
      current_phase: { id: "p7", name: "Migration phase" },
      drift_score: 0.8,
    });
    expect(r.markdown).toContain("Migration phase");
    expect(r.markdown).toContain("p7");
  });
});
