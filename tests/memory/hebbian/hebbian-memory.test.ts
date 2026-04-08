import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HebbianMemory } from "../../../src/memory/hebbian/hebbian-memory.js";

let tmpDir: string;
let memory: HebbianMemory;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hebb-mem-"));
  memory = new HebbianMemory({
    dbPath: join(tmpDir, "test.db"),
    activationDecay: 0.9,
    strengthDecay: 0.99,
    edgeDecay: 0.95,
    hebbianLR: 0.1,
    spreadFactor: 0.5,
    maxHops: 3,
    activationThreshold: 0.1,
  });
});

afterEach(() => {
  memory.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("HebbianMemory", () => {
  describe("storeNode", () => {
    it("creates node in SQLite", () => {
      const id = memory.storeNode("test lesson", {
        importance: 0.8,
        category: "lesson",
      });

      const node = memory.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.content).toBe("test lesson");
      expect(node!.importance).toBe(0.8);
      expect(node!.category).toBe("lesson");
      expect(node!.strength).toBe(1.0);
    });

    it("uses provided ID when given", () => {
      const id = memory.storeNode("with id", { id: "custom-id" });
      expect(id).toBe("custom-id");
      expect(memory.getNode("custom-id")).not.toBeNull();
    });
  });

  describe("recall", () => {
    it("activates and returns scored nodes", () => {
      const id1 = memory.storeNode("memory A", { importance: 0.9 });
      const id2 = memory.storeNode("memory B", { importance: 0.3 });

      const seeds = [
        { nodeId: id1, activation: 0.9 },
        { nodeId: id2, activation: 0.5 },
      ];
      const simMap = new Map([[id1, 0.9], [id2, 0.5]]);

      const results = memory.recall(seeds, simMap, 5);

      expect(results.length).toBeGreaterThanOrEqual(2);
      // First result should be the one with higher scores
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    });
  });

  describe("step", () => {
    it("applies decay to all nodes", () => {
      memory.storeNode("decaying memory", { id: "d1" });

      memory.step(10);

      const node = memory.getNode("d1")!;
      expect(node.strength).toBeLessThan(1.0);
      expect(node.strength).toBeCloseTo(Math.pow(0.99, 10), 6);
    });
  });

  describe("coActivate", () => {
    it("creates edges between specified nodes", () => {
      const a = memory.storeNode("A", { id: "a" });
      const b = memory.storeNode("B", { id: "b" });
      const c = memory.storeNode("C", { id: "c" });

      memory.coActivate([a, b, c]);

      const store = memory.getStore();
      expect(store.getEdge("a", "b")).not.toBeNull();
      expect(store.getEdge("b", "c")).not.toBeNull();
      expect(store.getEdge("a", "c")).not.toBeNull();
    });
  });

  describe("save/load round-trip", () => {
    it("data persists across instances", () => {
      const dbPath = join(tmpDir, "persist.db");

      const m1 = new HebbianMemory({ dbPath });
      m1.storeNode("persistent memory", { id: "p1", importance: 0.7, category: "pattern" });
      m1.close();

      const m2 = new HebbianMemory({ dbPath });
      const node = m2.getNode("p1");
      expect(node).not.toBeNull();
      expect(node!.content).toBe("persistent memory");
      expect(node!.importance).toBe(0.7);
      expect(node!.category).toBe("pattern");
      m2.close();
    });
  });

  describe("getStats", () => {
    it("returns correct stats", () => {
      memory.storeNode("lesson 1", { category: "lesson" });
      memory.storeNode("lesson 2", { category: "lesson" });
      memory.storeNode("pattern 1", { category: "pattern" });

      const stats = memory.getStats();
      expect(stats.nodeCount).toBe(3);
      expect(stats.categoryBreakdown["lesson"]).toBe(2);
      expect(stats.categoryBreakdown["pattern"]).toBe(1);
    });
  });

  describe("getNodeGraph", () => {
    it("returns node and its connections", () => {
      memory.storeNode("center", { id: "center" });
      memory.storeNode("neighbor1", { id: "n1" });
      memory.storeNode("neighbor2", { id: "n2" });
      memory.coActivate(["center", "n1", "n2"]);

      const graph = memory.getNodeGraph("center");
      expect(graph.node).not.toBeNull();
      expect(graph.node!.id).toBe("center");
      expect(graph.edges.length).toBeGreaterThanOrEqual(2);
    });
  });
});
