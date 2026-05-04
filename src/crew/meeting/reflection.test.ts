import { describe, expect, it } from "bun:test";

import {
  buildReflectionPrompt,
  parseReflection,
  stampReflection,
} from "./reflection.js";
import { CrewPhaseSchema, CrewTaskSchema } from "../types.js";
import type { AgentDefinition } from "../manifest/types.js";

const HAPPY_REFLECTION = JSON.stringify({
  went_well: ["t1 created src/health.ts cleanly", "tests pass first try"],
  went_poorly: ["t2 needed two retries on a typo in the route handler"],
  next_phase_focus: ["pick up better TS coverage on the new endpoint"],
  confidence: 78,
});

function agent(): AgentDefinition {
  return {
    id: "coder",
    name: "Coder",
    description: "writes code",
    prompt: "You are the coder.",
    tools: ["file_read", "file_write"],
  };
}

function phase() {
  return CrewPhaseSchema.parse({
    id: "p1",
    name: "Add health endpoint",
    description: "x",
    complexity_tier: "2",
    tasks: [
      CrewTaskSchema.parse({
        id: "t1",
        phase_id: "p1",
        description: "Create src/health.ts",
        assigned_agent: "coder",
        status: "completed",
        files_created: ["src/health.ts"],
      }),
    ],
  });
}

describe("parseReflection — happy path", () => {
  it("accepts a valid reflection", () => {
    const r = parseReflection(HAPPY_REFLECTION);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.went_well).toHaveLength(2);
      expect(r.payload.confidence).toBe(78);
    }
  });

  it("recovers from JSON wrapped in code fences", () => {
    const fenced = "```json\n" + HAPPY_REFLECTION + "\n```";
    const r = parseReflection(fenced);
    expect(r.ok).toBe(true);
  });
});

describe("parseReflection — rejections", () => {
  it("rejects malformed JSON with json_parse_failed", () => {
    const r = parseReflection("definitely not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_parse_failed");
  });

  it("rejects shape mismatch with schema_invalid", () => {
    const r = parseReflection(JSON.stringify({ wrong: "shape" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_invalid");
  });

  it("rejects confidence outside [0, 100]", () => {
    const bad = JSON.stringify({
      went_well: ["a"],
      went_poorly: ["b"],
      next_phase_focus: ["c"],
      confidence: 150,
    });
    const r = parseReflection(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_confidence");
  });

  it("rejects negative confidence", () => {
    const bad = JSON.stringify({
      went_well: ["a"],
      went_poorly: ["b"],
      next_phase_focus: ["c"],
      confidence: -5,
    });
    const r = parseReflection(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_confidence");
  });

  it("rejects trivial reflection (< 3 sentences total)", () => {
    const bad = JSON.stringify({
      went_well: ["ok"],
      went_poorly: [],
      next_phase_focus: [],
      confidence: 50,
    });
    const r = parseReflection(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("trivial_reflection");
  });

  it("counts list items + period-split fragments toward sentence count", () => {
    // 3 items in went_poorly counts as 3 sentences even with no periods.
    const r = parseReflection(
      JSON.stringify({
        went_well: [],
        went_poorly: ["one", "two", "three"],
        next_phase_focus: [],
        confidence: 50,
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("buildReflectionPrompt", () => {
  it("includes role, goal, task outcomes, and JSON spec", () => {
    const p = buildReflectionPrompt({
      agent_def: agent(),
      phase: phase(),
      goal: "Add a /health endpoint",
    });
    expect(p).toContain("agent 'coder'");
    expect(p).toContain("Add a /health endpoint");
    expect(p).toContain("t1 [coder] completed");
    expect(p).toContain("Output format");
    expect(p).toContain("JSON only");
  });

  it("appends a retry hint when supplied", () => {
    const p = buildReflectionPrompt({
      agent_def: agent(),
      phase: phase(),
      goal: "x",
      retry_hint: "previous: trivial_reflection",
    });
    expect(p).toContain("Retry");
    expect(p).toContain("trivial_reflection");
  });

  it("omits the prior-phases section when not supplied", () => {
    const p = buildReflectionPrompt({
      agent_def: agent(),
      phase: phase(),
      goal: "x",
    });
    expect(p).not.toContain("Earlier phases");
  });

  it("renders prior_phases_summary when supplied", () => {
    const p = buildReflectionPrompt({
      agent_def: agent(),
      phase: phase(),
      goal: "x",
      prior_phases_summary: "- p0 (Tier 1): seeded fixtures",
    });
    expect(p).toContain("Earlier phases");
    expect(p).toContain("seeded fixtures");
  });
});

describe("stampReflection", () => {
  it("stamps phase_id / agent_id / round onto a raw payload", () => {
    const raw = {
      went_well: ["a"],
      went_poorly: ["b"],
      next_phase_focus: ["c"],
      confidence: 70,
    };
    const stamped = stampReflection(raw, {
      phase_id: "p1",
      agent_id: "coder",
      round: 2,
    });
    expect(stamped.phase_id).toBe("p1");
    expect(stamped.agent_id).toBe("coder");
    expect(stamped.round).toBe(2);
    expect(stamped.confidence).toBe(70);
  });
});
