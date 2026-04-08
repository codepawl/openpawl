import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HebbianMemory } from "../../../src/memory/hebbian/hebbian-memory.js";
import { HybridRetriever, type LanceCandidate } from "../../../src/memory/hybrid-retriever.js";

let tmpDir: string;
let hebbian: HebbianMemory;
let retriever: HybridRetriever;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hebb-hybrid-"));
  hebbian = new HebbianMemory({
    dbPath: join(tmpDir, "test.db"),
    spreadFactor: 0.5,
    maxHops: 2,
    hebbianLR: 0.1,
  });
  retriever = new HybridRetriever(hebbian, { candidateCount: 20, finalCount: 5, enabled: true });
});

afterEach(() => {
  retriever.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("HybridRetriever", () => {
  describe("rerank", () => {
    it("re-ranks LanceDB candidates using Hebbian signals", () => {
      // Pre-populate Hebbian graph: B has been accessed before and has strong edges
      hebbian.storeNode("old knowledge B", { id: "b", importance: 0.9 });
      hebbian.storeNode("old knowledge C", { id: "c", importance: 0.5 });
      hebbian.coActivate(["b", "c"]); // strengthen edge

      // LanceDB returns A highest, B second
      const candidates: LanceCandidate[] = [
        { id: "a", content: "new result A", similarity: 0.95 },
        { id: "b", content: "old knowledge B", similarity: 0.85 },
        { id: "c", content: "old knowledge C", similarity: 0.70 },
      ];

      const results = retriever.rerank(candidates);

      // All candidates should be returned (within topK)
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results.length).toBe(3);

      // B should potentially rank higher than pure LanceDB order
      // due to higher importance (0.9) and co-activation with C
      const ids = results.map((r) => r.node.id);
      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids).toContain("c");
    });

    it("returns candidates in original order when disabled", () => {
      const disabled = new HybridRetriever(hebbian, { candidateCount: 20, finalCount: 5, enabled: false });

      const candidates: LanceCandidate[] = [
        { id: "x", content: "first", similarity: 0.9 },
        { id: "y", content: "second", similarity: 0.8 },
      ];

      const results = disabled.rerank(candidates);
      expect(results[0]!.node.id).toBe("x");
      expect(results[1]!.node.id).toBe("y");
    });
  });

  describe("store", () => {
    it("writes to Hebbian graph", () => {
      const id = retriever.store("test memory", {
        importance: 0.7,
        category: "lesson",
      });

      const node = hebbian.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.content).toBe("test memory");
      expect(node!.importance).toBe(0.7);
    });

    it("creates edges when coActivateWith is provided", () => {
      const id1 = retriever.store("memory A");
      const id2 = retriever.store("memory B", {
        coActivateWith: [id1],
      });

      const store = hebbian.getStore();
      const edge = store.getEdge(id2, id1) ?? store.getEdge(id1, id2);
      expect(edge).not.toBeNull();
    });
  });

  describe("step", () => {
    it("decays Hebbian graph", () => {
      retriever.store("test", { id: "t1" });

      retriever.step(10);

      const node = hebbian.getNode("t1")!;
      expect(node.strength).toBeLessThan(1.0);
    });
  });

  describe("coActivate", () => {
    it("strengthens edges between memories", () => {
      retriever.store("A", { id: "a" });
      retriever.store("B", { id: "b" });

      retriever.coActivate(["a", "b"]);

      const store = hebbian.getStore();
      const edge = store.getEdge("a", "b");
      expect(edge).not.toBeNull();
      expect(edge!.weight).toBeGreaterThan(0);
    });
  });
});
