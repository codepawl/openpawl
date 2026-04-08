import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HebbianStore } from "../../../src/memory/hebbian/store.js";
import { hebbianUpdate } from "../../../src/memory/hebbian/hebbian-update.js";
import { DEFAULT_CONFIG, type HebbianConfig } from "../../../src/memory/hebbian/types.js";

let tmpDir: string;
let store: HebbianStore;
const config: HebbianConfig = { ...DEFAULT_CONFIG, dbPath: "", hebbianLR: 0.1 };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hebb-update-"));
  config.dbPath = join(tmpDir, "test.db");
  store = new HebbianStore(config.dbPath);

  for (const id of ["a", "b", "c"]) {
    store.upsertNode({
      id,
      content: `node ${id}`,
      strength: 1.0,
      activation: 0.5,
      importance: 0.5,
      category: "context",
      metadata: {},
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
  }
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("hebbianUpdate", () => {
  it("creates edge if none exists", () => {
    hebbianUpdate(store, config, ["a", "b"]);

    const ab = store.getEdge("a", "b");
    const ba = store.getEdge("b", "a");
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
    expect(ab!.weight).toBeCloseTo(0.1, 4); // lr = 0.1, initial w=0 → 0 + 0.1*(1-0) = 0.1
  });

  it("strengthens existing edge", () => {
    store.upsertEdge({ sourceId: "a", targetId: "b", weight: 0.5, coActivationCount: 1 });

    hebbianUpdate(store, config, ["a", "b"]);

    const edge = store.getEdge("a", "b")!;
    // w = min(1.0, 0.5 + 0.1 * (1 - 0.5)) = 0.55
    expect(edge.weight).toBeCloseTo(0.55, 4);
  });

  it("weight is clamped to [0, 1]", () => {
    store.upsertEdge({ sourceId: "a", targetId: "b", weight: 0.99, coActivationCount: 10 });

    hebbianUpdate(store, config, ["a", "b"]);

    const edge = store.getEdge("a", "b")!;
    expect(edge.weight).toBeLessThanOrEqual(1.0);
  });

  it("increments coActivationCount", () => {
    store.upsertEdge({ sourceId: "a", targetId: "b", weight: 0.3, coActivationCount: 5 });

    hebbianUpdate(store, config, ["a", "b"]);

    const edge = store.getEdge("a", "b")!;
    expect(edge.coActivationCount).toBe(6);
  });

  it("learning rate affects weight increase", () => {
    const slowConfig = { ...config, hebbianLR: 0.01 };
    const fastConfig = { ...config, hebbianLR: 0.5 };

    hebbianUpdate(store, slowConfig, ["a", "b"]);
    const slowEdge = store.getEdge("a", "b")!;

    // Reset
    store.upsertEdge({ sourceId: "a", targetId: "b", weight: 0, coActivationCount: 0 });
    hebbianUpdate(store, fastConfig, ["a", "b"]);
    const fastEdge = store.getEdge("a", "b")!;

    expect(fastEdge.weight).toBeGreaterThan(slowEdge.weight);
  });

  it("creates edges between all pairs when 3+ nodes co-activate", () => {
    hebbianUpdate(store, config, ["a", "b", "c"]);

    // All 6 directed edges (both directions for 3 pairs)
    expect(store.getEdge("a", "b")).not.toBeNull();
    expect(store.getEdge("b", "a")).not.toBeNull();
    expect(store.getEdge("a", "c")).not.toBeNull();
    expect(store.getEdge("c", "a")).not.toBeNull();
    expect(store.getEdge("b", "c")).not.toBeNull();
    expect(store.getEdge("c", "b")).not.toBeNull();
  });

  it("does nothing with fewer than 2 nodes", () => {
    hebbianUpdate(store, config, ["a"]);
    expect(store.edgeCount()).toBe(0);

    hebbianUpdate(store, config, []);
    expect(store.edgeCount()).toBe(0);
  });
});
