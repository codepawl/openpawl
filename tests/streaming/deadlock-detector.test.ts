import { describe, it, expect } from "vitest";
import { DeadlockDetector } from "../../src/streaming/deadlock-detector.js";
import type { AgentAssignment } from "../../src/router/router-types.js";

function assign(id: string, deps?: string[]): AgentAssignment {
  return { agentId: id, role: id, task: "", tools: [], priority: 0, dependsOn: deps };
}

describe("DeadlockDetector", () => {
  const detector = new DeadlockDetector();

  it("no cycle in valid chain → deadlock: false", () => {
    const result = detector.detect([assign("a"), assign("b", ["a"]), assign("c", ["b"])]);
    expect(result.deadlock).toBe(false);
  });

  it("A→B→A cycle detected", () => {
    const result = detector.detect([assign("a", ["b"]), assign("b", ["a"])]);
    expect(result.deadlock).toBe(true);
    if (result.deadlock) {
      expect(result.cycle.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("A→B→C→A cycle detected", () => {
    const result = detector.detect([assign("a", ["c"]), assign("b", ["a"]), assign("c", ["b"])]);
    expect(result.deadlock).toBe(true);
  });

  it("disconnected graph (no deps) → no deadlock", () => {
    const result = detector.detect([assign("a"), assign("b"), assign("c")]);
    expect(result.deadlock).toBe(false);
  });

  it("self-dependency detected", () => {
    const result = detector.detect([assign("a", ["a"])]);
    expect(result.deadlock).toBe(true);
  });
});
