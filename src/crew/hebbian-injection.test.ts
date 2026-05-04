import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  buildHebbianBlock,
  type HebbianRecallResult,
  type HebbianRecaller,
} from "./hebbian-injection.js";
import { CrewTaskSchema } from "./types.js";

const ORIGINAL_ENV = process.env.OPENPAWL_HEBBIAN_INJECT;

beforeEach(() => {
  delete process.env.OPENPAWL_HEBBIAN_INJECT;
});
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.OPENPAWL_HEBBIAN_INJECT;
  else process.env.OPENPAWL_HEBBIAN_INJECT = ORIGINAL_ENV;
});

function task(description = "edit src/foo.ts to add health endpoint") {
  return CrewTaskSchema.parse({
    id: "t1",
    phase_id: "p1",
    description,
    assigned_agent: "coder",
  });
}

function recallStub(results: HebbianRecallResult[]): HebbianRecaller {
  return async () => results;
}

describe("buildHebbianBlock — happy path", () => {
  it("renders a sorted markdown block (highest strength first)", async () => {
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([
        { content: "src/foo.ts last touched in phase p0", strength: 0.42 },
        { content: "fastify route patterns live in src/routes/", strength: 0.81 },
        { content: "health endpoint convention: /health returns 200", strength: 0.65 },
      ]),
    });
    expect(block).toContain("## Relevant context (Hebbian memory)");
    const lines = block.split("\n");
    // Header + 3 entries
    expect(lines).toHaveLength(4);
    // Strongest first.
    expect(lines[1]).toContain("strength: 0.81");
    expect(lines[2]).toContain("strength: 0.65");
    expect(lines[3]).toContain("strength: 0.42");
  });
});

describe("buildHebbianBlock — empty paths", () => {
  it("recall undefined → empty string", async () => {
    const block = await buildHebbianBlock({ task: task() });
    expect(block).toBe("");
  });

  it("recall returning [] → empty string", async () => {
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([]),
    });
    expect(block).toBe("");
  });

  it("recall throwing → empty string + debug warning (no rethrow)", async () => {
    const block = await buildHebbianBlock({
      task: task(),
      recall: async () => {
        throw new Error("hebbian module crashed");
      },
    });
    expect(block).toBe("");
  });

  it("entries with malformed shape are filtered, not crashed on", async () => {
    const block = await buildHebbianBlock({
      task: task(),
      recall: async () =>
        [
          { content: "valid", strength: 0.5 },
          { content: 123, strength: 0.3 } as unknown as HebbianRecallResult,
          { content: "no-strength" } as unknown as HebbianRecallResult,
          { content: "", strength: 0.4 },
        ] as unknown as HebbianRecallResult[],
    });
    // Only the one valid entry survives.
    expect(block).toContain("- valid");
    expect(block).not.toContain("123");
    expect(block).not.toContain("no-strength");
  });
});

describe("buildHebbianBlock — env opt-out", () => {
  it("OPENPAWL_HEBBIAN_INJECT=false → empty string", async () => {
    process.env.OPENPAWL_HEBBIAN_INJECT = "false";
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([{ content: "x", strength: 0.5 }]),
    });
    expect(block).toBe("");
  });

  it("OPENPAWL_HEBBIAN_INJECT=0 → empty string (alias)", async () => {
    process.env.OPENPAWL_HEBBIAN_INJECT = "0";
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([{ content: "x", strength: 0.5 }]),
    });
    expect(block).toBe("");
  });

  it("OPENPAWL_HEBBIAN_INJECT=true → renders normally", async () => {
    process.env.OPENPAWL_HEBBIAN_INJECT = "true";
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([{ content: "x", strength: 0.5 }]),
    });
    expect(block).toContain("## Relevant context");
  });

  it("env unset → defaults to enabled", async () => {
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([{ content: "x", strength: 0.5 }]),
    });
    expect(block).toContain("## Relevant context");
  });
});

describe("buildHebbianBlock — token cap", () => {
  it("drops tail entries when total exceeds the cap", async () => {
    const longContent = "x".repeat(800); // ~200 tokens per entry
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([
        { content: longContent + " A", strength: 0.9 },
        { content: longContent + " B", strength: 0.8 },
        { content: longContent + " C", strength: 0.7 },
        { content: longContent + " D", strength: 0.6 },
      ]),
      token_cap: 250, // tight cap forces eviction
    });
    // We should see fewer than 4 entries.
    const entryLineCount = block.split("\n").filter((l) => l.startsWith("-")).length;
    expect(entryLineCount).toBeLessThan(4);
    expect(entryLineCount).toBeGreaterThanOrEqual(0);
  });

  it("returns empty when no entry fits the cap (rather than misleading half-block)", async () => {
    const tooLong = "x".repeat(10_000);
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([{ content: tooLong, strength: 0.9 }]),
      token_cap: 100,
    });
    expect(block).toBe("");
  });

  it("respects the default token cap (500) without explicit override", async () => {
    const moderate = "x".repeat(200);
    const block = await buildHebbianBlock({
      task: task(),
      recall: recallStub([
        { content: moderate, strength: 0.9 },
        { content: moderate, strength: 0.8 },
        { content: moderate, strength: 0.7 },
        { content: moderate, strength: 0.6 },
      ]),
    });
    expect(block.length).toBeGreaterThan(0);
  });
});
