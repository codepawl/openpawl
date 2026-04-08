import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HebbianStore } from "../../../src/memory/hebbian/store.js";
import { spreadActivation } from "../../../src/memory/hebbian/activation.js";
import { DEFAULT_CONFIG, type HebbianConfig } from "../../../src/memory/hebbian/types.js";

let tmpDir: string;
let store: HebbianStore;
const config: HebbianConfig = {
  ...DEFAULT_CONFIG,
  dbPath: "",
  spreadFactor: 0.5,
  maxHops: 3,
  activationThreshold: 0.1,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hebb-act-"));
  config.dbPath = join(tmpDir, "test.db");
  store = new HebbianStore(config.dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function addNode(id: string, strength = 1.0): void {
  store.upsertNode({
    id,
    content: `node ${id}`,
    strength,
    activation: 0.0,
    importance: 0.5,
    category: "context",
    metadata: {},
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
}

function addEdge(src: string, tgt: string, weight = 0.8): void {
  store.upsertEdge({ sourceId: src, targetId: tgt, weight, coActivationCount: 1 });
}

describe("spreadActivation", () => {
  it("seeds get their initial activation set", () => {
    addNode("a");

    const activated = spreadActivation(store, config, [{ nodeId: "a", activation: 0.7 }]);

    expect(activated).toContain("a");
    const node = store.getNode("a")!;
    expect(node.activation).toBeCloseTo(0.7, 4);
  });

  it("spreads to 1-hop neighbors", () => {
    addNode("a");
    addNode("b");
    addEdge("a", "b", 0.8);

    const activated = spreadActivation(store, config, [{ nodeId: "a", activation: 0.9 }]);

    expect(activated).toContain("a");
    expect(activated).toContain("b");

    const b = store.getNode("b")!;
    // b.activation = a.activation * edge.weight * spreadFactor = 0.9 * 0.8 * 0.5 = 0.36
    expect(b.activation).toBeCloseTo(0.36, 4);
  });

  it("spread factor reduces activation per hop", () => {
    addNode("a");
    addNode("b");
    addNode("c");
    addEdge("a", "b", 1.0);
    addEdge("b", "c", 1.0);

    spreadActivation(store, config, [{ nodeId: "a", activation: 1.0 }]);

    const b = store.getNode("b")!;
    const c = store.getNode("c")!;

    // b gets 0.5 from a (hop 0→1), plus 0.125 back from c (hop 2→back)
    // because getNeighborEdges is bidirectional
    expect(b.activation).toBeCloseTo(0.625, 4);
    // c = 0.5 * 1.0 * 0.5 = 0.25
    expect(c.activation).toBeCloseTo(0.25, 4);

    // Key property: activation decreases with distance from seed
    expect(b.activation).toBeGreaterThan(c.activation);
  });

  it("maxHops limits BFS depth", () => {
    // Chain: a -> b -> c -> d -> e (4 hops)
    for (const id of ["a", "b", "c", "d", "e"]) addNode(id);
    addEdge("a", "b", 1.0);
    addEdge("b", "c", 1.0);
    addEdge("c", "d", 1.0);
    addEdge("d", "e", 1.0);

    const oneHopConfig = { ...config, maxHops: 1 };
    const activated = spreadActivation(store, oneHopConfig, [{ nodeId: "a", activation: 1.0 }]);

    expect(activated).toContain("a");
    expect(activated).toContain("b");
    // c should not be reached with maxHops=1
    const c = store.getNode("c")!;
    expect(c.activation).toBe(0);
  });

  it("disconnected nodes get zero spreading activation", () => {
    addNode("a");
    addNode("isolated");

    spreadActivation(store, config, [{ nodeId: "a", activation: 1.0 }]);

    const isolated = store.getNode("isolated")!;
    expect(isolated.activation).toBe(0);
  });

  it("circular graphs do not cause infinite loops", () => {
    addNode("a");
    addNode("b");
    addNode("c");
    addEdge("a", "b", 1.0);
    addEdge("b", "c", 1.0);
    addEdge("c", "a", 1.0); // cycle

    // Should complete without hanging
    const activated = spreadActivation(store, config, [{ nodeId: "a", activation: 1.0 }]);

    expect(activated.length).toBeGreaterThanOrEqual(3);
  });

  it("activation is clamped to [0, 1]", () => {
    addNode("a");
    addNode("b");
    addEdge("a", "b", 1.0);
    addEdge("b", "a", 1.0); // bidirectional

    // Multiple seeds feeding the same node
    spreadActivation(store, config, [
      { nodeId: "a", activation: 0.9 },
      { nodeId: "b", activation: 0.9 },
    ]);

    const a = store.getNode("a")!;
    expect(a.activation).toBeLessThanOrEqual(1.0);
  });

  it("skips dormant nodes (strength < 0.01)", () => {
    addNode("a");
    addNode("dormant", 0.005);
    addEdge("a", "dormant", 1.0);

    const activated = spreadActivation(store, config, [{ nodeId: "a", activation: 1.0 }]);

    expect(activated).not.toContain("dormant");
  });
});
