import { describe, it, expect } from "bun:test";
import { scoreNodes } from "../../../src/memory/hebbian/scorer.js";
import type { MemoryNode, ScoringWeights } from "../../../src/memory/hebbian/types.js";

function makeNode(overrides: Partial<MemoryNode> & { id: string }): MemoryNode {
  return {
    content: `node ${overrides.id}`,
    strength: 0.5,
    activation: 0.5,
    importance: 0.5,
    category: "context",
    metadata: {},
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ...overrides,
  };
}

const WEIGHTS: ScoringWeights = {
  activation: 0.4,
  similarity: 0.35,
  strength: 0.15,
  importance: 0.1,
};

describe("scoreNodes", () => {
  it("applies weights correctly", () => {
    const node = makeNode({ id: "a", activation: 1.0, strength: 1.0, importance: 1.0 });
    const similarityMap = new Map([["a", 1.0]]);

    const results = scoreNodes([node], similarityMap, WEIGHTS, 5);

    expect(results).toHaveLength(1);
    // 0.4*1 + 0.35*1 + 0.15*1 + 0.1*1 = 1.0
    expect(results[0]!.score).toBeCloseTo(1.0, 4);
  });

  it("all-zero weights = zero score", () => {
    const node = makeNode({ id: "a", activation: 0.8, strength: 0.8, importance: 0.8 });
    const zeroWeights: ScoringWeights = { activation: 0, similarity: 0, strength: 0, importance: 0 };

    const results = scoreNodes([node], new Map([["a", 0.8]]), zeroWeights, 5);

    expect(results[0]!.score).toBe(0);
  });

  it("higher activation + higher similarity = top rank", () => {
    const high = makeNode({ id: "high", activation: 0.9, strength: 0.8, importance: 0.7 });
    const low = makeNode({ id: "low", activation: 0.1, strength: 0.2, importance: 0.1 });

    const similarityMap = new Map([["high", 0.95], ["low", 0.3]]);
    const results = scoreNodes([low, high], similarityMap, WEIGHTS, 5);

    expect(results[0]!.node.id).toBe("high");
    expect(results[1]!.node.id).toBe("low");
  });

  it("respects topK limit", () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({ id: `n${i}`, activation: i / 10 }),
    );
    const simMap = new Map(nodes.map((n) => [n.id, 0.5]));

    const results = scoreNodes(nodes, simMap, WEIGHTS, 3);
    expect(results).toHaveLength(3);
  });

  it("breakdown contains individual component values", () => {
    const node = makeNode({ id: "a", activation: 0.7, strength: 0.6, importance: 0.3 });
    const simMap = new Map([["a", 0.8]]);

    const results = scoreNodes([node], simMap, WEIGHTS, 5);
    const bd = results[0]!.breakdown;

    expect(bd.activation).toBe(0.7);
    expect(bd.similarity).toBe(0.8);
    expect(bd.strength).toBe(0.6);
    expect(bd.importance).toBe(0.3);
  });

  it("nodes without similarity get 0 for that component", () => {
    const node = makeNode({ id: "a", activation: 0.5, strength: 0.5, importance: 0.5 });
    const emptyMap = new Map<string, number>();

    const results = scoreNodes([node], emptyMap, WEIGHTS, 5);

    expect(results[0]!.breakdown.similarity).toBe(0);
    // Score = 0.4*0.5 + 0.35*0 + 0.15*0.5 + 0.1*0.5 = 0.325
    expect(results[0]!.score).toBeCloseTo(0.325, 4);
  });
});
