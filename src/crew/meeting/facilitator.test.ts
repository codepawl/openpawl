import { describe, expect, it } from "bun:test";

import {
  buildFacilitatorPrompt,
  buildFallbackSummary,
  parseFacilitatorOutput,
} from "./facilitator.js";
import { CrewPhaseSchema, CrewTaskSchema } from "../types.js";
import type { ReflectionArtifactPayload } from "../artifacts/types.js";

const HAPPY_MARKDOWN = `## Phase Add health endpoint retrospective

### What we achieved
- t1 created src/health.ts cleanly
- tests pass first try

### What we're debating
- whether the route should sit at /health or /healthz

### Missing perspective
- nobody examined the latency budget for the new endpoint

### Proposed next phase
- write tests for the new endpoint
- add a metric to the Prometheus exporter
`;

function reflection(
  agent_id: string,
  overrides: Partial<ReflectionArtifactPayload> = {},
): ReflectionArtifactPayload {
  return {
    phase_id: "p1",
    agent_id,
    went_well: ["t1 finished"],
    went_poorly: ["t2 needed retry"],
    next_phase_focus: ["lift coverage"],
    confidence: 70,
    round: 1,
    ...overrides,
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
      }),
    ],
  });
}

describe("parseFacilitatorOutput — happy path", () => {
  it("accepts well-formed markdown", () => {
    const r = parseFacilitatorOutput(HAPPY_MARKDOWN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.markdown).toContain("Proposed next phase");
  });

  it("trims surrounding whitespace", () => {
    const r = parseFacilitatorOutput(`\n\n${HAPPY_MARKDOWN}\n\n`);
    expect(r.ok).toBe(true);
  });

  it("matches case-insensitive 'proposed next phase' header", () => {
    const md = HAPPY_MARKDOWN.replace(
      "### Proposed next phase",
      "### PROPOSED NEXT PHASE",
    );
    const r = parseFacilitatorOutput(md);
    expect(r.ok).toBe(true);
  });
});

describe("parseFacilitatorOutput — rejections", () => {
  it("rejects too_short", () => {
    const r = parseFacilitatorOutput("## Phase x retrospective\n\n### Proposed next phase\n- t");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_short");
  });

  it("rejects missing_proposal_section", () => {
    const md = HAPPY_MARKDOWN.replace("### Proposed next phase", "### Notes");
    const r = parseFacilitatorOutput(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_proposal_section");
  });
});

describe("buildFacilitatorPrompt", () => {
  it("renders reflections with confidence + round + bullet lists", () => {
    const p = buildFacilitatorPrompt({
      phase: phase(),
      reflections: [
        { agent_id: "coder", payload: reflection("coder") },
        { agent_id: "tester", payload: reflection("tester", { confidence: 50 }) },
      ],
      goal: "Add a /health endpoint",
      round: 1,
    });
    expect(p).toContain("phase 'Add health endpoint'");
    expect(p).toContain("Add a /health endpoint");
    expect(p).toContain("coder (round 1, confidence 70)");
    expect(p).toContain("tester (round 1, confidence 50)");
    expect(p).toContain("Output format");
    expect(p).toContain("Proposed next phase");
  });

  it("Round 2 prompt mentions RA-CR re-synthesis", () => {
    const p = buildFacilitatorPrompt({
      phase: phase(),
      reflections: [{ agent_id: "coder", payload: reflection("coder", { round: 2 }) }],
      goal: "x",
      round: 2,
    });
    expect(p).toContain("Round 2");
    expect(p).toContain("RA-CR");
  });

  it("appends a retry hint when supplied", () => {
    const p = buildFacilitatorPrompt({
      phase: phase(),
      reflections: [{ agent_id: "coder", payload: reflection("coder") }],
      goal: "x",
      round: 1,
      retry_hint: "previous: missing_proposal_section",
    });
    expect(p).toContain("Retry");
    expect(p).toContain("missing_proposal_section");
  });
});

describe("buildFallbackSummary", () => {
  it("produces markdown that passes parseFacilitatorOutput", () => {
    const md = buildFallbackSummary({
      phase: phase(),
      reflections: [
        { agent_id: "coder", payload: reflection("coder") },
        { agent_id: "tester", payload: reflection("tester") },
      ],
    });
    const parsed = parseFacilitatorOutput(md);
    expect(parsed.ok).toBe(true);
    expect(md).toContain("Auto-generated fallback summary");
    expect(md).toContain("### Proposed next phase");
  });

  it("handles zero reflections without crashing", () => {
    const md = buildFallbackSummary({
      phase: phase(),
      reflections: [],
    });
    expect(md).toContain("Phase Add health endpoint retrospective");
    expect(md).toContain("Proposed next phase");
  });

  it("renders confidence summary in the missing-perspective section", () => {
    const md = buildFallbackSummary({
      phase: phase(),
      reflections: [
        { agent_id: "coder", payload: reflection("coder", { confidence: 80 }) },
        { agent_id: "tester", payload: reflection("tester", { confidence: 60 }) },
      ],
    });
    expect(md).toContain("coder=80");
    expect(md).toContain("tester=60");
  });
});
