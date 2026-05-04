import { describe, expect, it } from "bun:test";

import {
  buildAntiSycophancyRetryPrompt,
  detectSycophancy,
  fingerprintReflection,
} from "./sycophancy.js";
import type { ReflectionArtifactPayload } from "../artifacts/types.js";

function reflection(
  agentId: string,
  overrides: Partial<ReflectionArtifactPayload> = {},
): ReflectionArtifactPayload {
  return {
    phase_id: "p1",
    agent_id: agentId,
    went_well: ["t1 finished cleanly"],
    went_poorly: ["t2 needed a retry"],
    next_phase_focus: ["lift coverage"],
    confidence: 70,
    round: 1,
    ...overrides,
  };
}

describe("fingerprintReflection", () => {
  it("is stable across whitespace + case differences (paraphrase collision)", () => {
    const a = reflection("coder", {
      went_well: ["T1 Finished CLEANLY"],
      went_poorly: ["T2  needed   a retry"],
    });
    const b = reflection("tester", {
      went_well: ["t1 finished cleanly"],
      went_poorly: ["t2 needed a retry"],
    });
    expect(fingerprintReflection(a)).toBe(fingerprintReflection(b));
  });

  it("differs when the went_well/went_poorly content differs", () => {
    const a = reflection("coder");
    const b = reflection("tester", { went_well: ["completely different observation"] });
    expect(fingerprintReflection(a)).not.toBe(fingerprintReflection(b));
  });

  it("ignores next_phase_focus differences (legitimate convergence)", () => {
    const a = reflection("coder", { next_phase_focus: ["x"] });
    const b = reflection("tester", { next_phase_focus: ["completely different next focus"] });
    expect(fingerprintReflection(a)).toBe(fingerprintReflection(b));
  });
});

describe("detectSycophancy", () => {
  it("two identical reflections → flagged with both agent ids in the duplicate group", () => {
    const r = detectSycophancy([
      reflection("coder"),
      reflection("tester"),
      reflection("reviewer", { went_well: ["something else"] }),
    ]);
    expect(r.flagged).toBe(true);
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]?.agent_ids.sort()).toEqual(["coder", "tester"]);
  });

  it("two paraphrased reflections (same after normalize) are detected", () => {
    const r = detectSycophancy([
      reflection("coder", {
        went_well: ["T1   COMPLETED   ON   TIME"],
        went_poorly: ["T2 had retries"],
      }),
      reflection("tester", {
        went_well: ["t1 completed on time"],
        went_poorly: ["T2 had  RETRIES"],
      }),
    ]);
    expect(r.flagged).toBe(true);
  });

  it("all-distinct reflections pass without flagging", () => {
    const r = detectSycophancy([
      reflection("coder", { went_well: ["alpha unique observation"] }),
      reflection("tester", { went_well: ["beta different observation"] }),
      reflection("reviewer", { went_well: ["gamma yet another"] }),
    ]);
    expect(r.flagged).toBe(false);
    expect(r.duplicates).toHaveLength(0);
  });

  it("three identical reflections produce one group with three agent ids", () => {
    const r = detectSycophancy([
      reflection("a"),
      reflection("b"),
      reflection("c"),
    ]);
    expect(r.flagged).toBe(true);
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]?.agent_ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("empty input returns flagged=false", () => {
    const r = detectSycophancy([]);
    expect(r.flagged).toBe(false);
  });

  it("single reflection returns flagged=false", () => {
    const r = detectSycophancy([reflection("only")]);
    expect(r.flagged).toBe(false);
  });
});

describe("buildAntiSycophancyRetryPrompt", () => {
  it("renders peer reflections excluding the retrying agent", () => {
    const prompt = buildAntiSycophancyRetryPrompt({
      original_prompt: "ORIGINAL",
      peer_reflections: [
        { agent_id: "coder", payload: reflection("coder") },
        { agent_id: "tester", payload: reflection("tester") },
        { agent_id: "reviewer", payload: reflection("reviewer") },
      ],
      this_agent_id: "coder",
    });
    expect(prompt).toContain("ORIGINAL");
    expect(prompt).toContain("Sycophancy retry");
    expect(prompt).toContain("tester");
    expect(prompt).toContain("reviewer");
    // The retrying agent should not appear in the peer list.
    const peerSection = prompt.split("Peer reflections seen this round:")[1] ?? "";
    expect(peerSection).not.toContain("- coder:");
  });

  it("explicitly instructs to disagree and cite evidence", () => {
    const prompt = buildAntiSycophancyRetryPrompt({
      original_prompt: "x",
      peer_reflections: [{ agent_id: "tester", payload: reflection("tester") }],
      this_agent_id: "coder",
    });
    expect(prompt).toContain("disagree");
    expect(prompt).toMatch(/cite|fact|evidence/i);
  });
});
