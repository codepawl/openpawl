import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HebbianStore } from "../../../src/memory/hebbian/store.js";
import { applyDecay } from "../../../src/memory/hebbian/decay.js";
import { DEFAULT_CONFIG, type HebbianConfig } from "../../../src/memory/hebbian/types.js";

let tmpDir: string;
let store: HebbianStore;
const config: HebbianConfig = {
  ...DEFAULT_CONFIG,
  dbPath: "",
  activationDecay: 0.9,
  strengthDecay: 0.99,
  edgeDecay: 0.95,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hebb-decay-"));
  config.dbPath = join(tmpDir, "test.db");
  store = new HebbianStore(config.dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function addNode(id: string, strength = 1.0, activation = 1.0): void {
  store.upsertNode({
    id,
    content: `node ${id}`,
    strength,
    activation,
    importance: 0.5,
    category: "context",
    metadata: {},
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
}

describe("applyDecay", () => {
  it("decays strength correctly over N ticks", () => {
    addNode("a", 1.0, 0.0);
    applyDecay(store, config, 10);

    const node = store.getNode("a")!;
    const expected = Math.pow(0.99, 10);
    expect(node.strength).toBeCloseTo(expected, 6);
  });

  it("decays activation faster than strength", () => {
    addNode("a", 1.0, 1.0);
    applyDecay(store, config, 5);

    const node = store.getNode("a")!;
    expect(node.activation).toBeLessThan(node.strength);
    expect(node.activation).toBeCloseTo(Math.pow(0.9, 5), 6);
    expect(node.strength).toBeCloseTo(Math.pow(0.99, 5), 6);
  });

  it("zero ticks = no decay", () => {
    addNode("a", 0.8, 0.6);
    applyDecay(store, config, 0);

    const node = store.getNode("a")!;
    expect(node.strength).toBeCloseTo(0.8, 6);
    expect(node.activation).toBeCloseTo(0.6, 6);
  });

  it("nodes below threshold are skipped in active queries", () => {
    addNode("a", 0.005, 0.001); // below 0.01 threshold

    const active = store.getActiveNodes(0.01);
    expect(active).toHaveLength(0);
  });

  it("decays edge weights", () => {
    addNode("a");
    addNode("b");
    store.upsertEdge({ sourceId: "a", targetId: "b", weight: 1.0, coActivationCount: 5 });

    applyDecay(store, config, 10);

    const edge = store.getEdge("a", "b")!;
    expect(edge.weight).toBeCloseTo(Math.pow(0.95, 10), 6);
  });

  it("prunes edges with weight below 0.01 after decay", () => {
    addNode("a");
    addNode("b");
    store.upsertEdge({ sourceId: "a", targetId: "b", weight: 0.02, coActivationCount: 1 });

    // After enough ticks, weight drops below 0.01
    applyDecay(store, config, 20); // 0.02 * 0.95^20 ≈ 0.0072

    const edge = store.getEdge("a", "b");
    expect(edge).toBeNull();
  });
});
