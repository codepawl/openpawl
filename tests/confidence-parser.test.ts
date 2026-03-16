import { describe, it, expect } from "vitest";
import { parseConfidence } from "../src/graph/confidence/parser.js";

describe("parseConfidence", () => {
  it("extracts score, reasoning, and flags from a valid block", () => {
    const raw = `Here is my output.

<confidence>
score: 0.82
reasoning: Mostly complete but one edge case untested
flags: untested_approach, partial_completion
</confidence>`;

    const { confidence, cleanedOutput } = parseConfidence(raw);
    expect(confidence.score).toBe(0.82);
    expect(confidence.reasoning).toBe("Mostly complete but one edge case untested");
    expect(confidence.flags).toEqual(["untested_approach", "partial_completion"]);
    expect(cleanedOutput).toBe("Here is my output.");
  });

  it("defaults to 0.5 and missing_context when block is absent", () => {
    const raw = "Just some output without any confidence block.";
    const { confidence, cleanedOutput } = parseConfidence(raw);
    expect(confidence.score).toBe(0.5);
    expect(confidence.reasoning).toBe("No confidence block provided");
    expect(confidence.flags).toEqual(["missing_context"]);
    expect(cleanedOutput).toBe(raw);
  });

  it("strips the confidence block from visible content", () => {
    const raw = `Start of output.
<confidence>
score: 0.9
reasoning: All good
flags:
</confidence>
End of output.`;

    const { cleanedOutput } = parseConfidence(raw);
    expect(cleanedOutput).not.toContain("<confidence>");
    expect(cleanedOutput).not.toContain("</confidence>");
    expect(cleanedOutput).toContain("Start of output.");
    expect(cleanedOutput).toContain("End of output.");
  });

  it("handles malformed blocks with missing fields", () => {
    const raw = `Output here.
<confidence>
score: 0.7
</confidence>`;

    const { confidence } = parseConfidence(raw);
    expect(confidence.score).toBe(0.7);
    expect(confidence.reasoning).toBe("No reasoning provided");
    expect(confidence.flags).toEqual([]);
  });

  it("handles malformed score (non-numeric)", () => {
    const raw = `<confidence>
score: abc
reasoning: Bad score
flags: missing_context
</confidence>`;

    const { confidence } = parseConfidence(raw);
    expect(confidence.score).toBe(0.5);
  });

  it("clamps score to [0, 1]", () => {
    const rawHigh = `<confidence>
score: 1.5
reasoning: Over
flags:
</confidence>`;
    expect(parseConfidence(rawHigh).confidence.score).toBe(1);

    const rawLow = `<confidence>
score: -0.3
reasoning: Under
flags:
</confidence>`;
    expect(parseConfidence(rawLow).confidence.score).toBe(0);
  });

  it("filters unknown flags", () => {
    const raw = `<confidence>
score: 0.6
reasoning: Some flags are unknown
flags: missing_context, totally_fake_flag, high_complexity
</confidence>`;

    const { confidence } = parseConfidence(raw);
    expect(confidence.flags).toEqual(["missing_context", "high_complexity"]);
  });

  it("takes the last confidence block when multiple are present", () => {
    const raw = `Output.
<confidence>
score: 0.3
reasoning: First block
flags:
</confidence>
More output.
<confidence>
score: 0.9
reasoning: Last block wins
flags: high_complexity
</confidence>`;

    const { confidence } = parseConfidence(raw);
    expect(confidence.score).toBe(0.9);
    expect(confidence.reasoning).toBe("Last block wins");
    expect(confidence.flags).toEqual(["high_complexity"]);
  });
});
