import { describe, expect, it } from "bun:test";

import { DoomLoopDetector } from "./doom-loop.js";

describe("DoomLoopDetector", () => {
  it("first two identical records do not block; the third does", () => {
    const d = new DoomLoopDetector();
    const rec = { agent_id: "coder", task_id: "t1", error_kind: "agent_logic", exit_code: 1 };
    expect(d.record(rec).blocked).toBe(false);
    expect(d.record(rec).blocked).toBe(false);
    expect(d.record(rec).blocked).toBe(true);
    expect(d.shouldBlock("t1")).toBe(true);
  });

  it("different exit codes count as different fingerprints", () => {
    const d = new DoomLoopDetector();
    d.record({ agent_id: "coder", task_id: "t1", error_kind: "agent_logic", exit_code: 1 });
    d.record({ agent_id: "coder", task_id: "t1", error_kind: "agent_logic", exit_code: 2 });
    d.record({ agent_id: "coder", task_id: "t1", error_kind: "agent_logic", exit_code: 3 });
    expect(d.shouldBlock("t1")).toBe(false);
  });

  it("different error_kinds are tracked separately", () => {
    const d = new DoomLoopDetector();
    d.record({ agent_id: "coder", task_id: "t1", error_kind: "agent_logic", exit_code: 1 });
    d.record({ agent_id: "coder", task_id: "t1", error_kind: "timeout", exit_code: 1 });
    d.record({ agent_id: "coder", task_id: "t1", error_kind: "env_perm", exit_code: 1 });
    expect(d.shouldBlock("t1")).toBe(false);
  });

  it("different agents on same task are tracked separately", () => {
    const d = new DoomLoopDetector();
    d.record({ agent_id: "coder", task_id: "t1", error_kind: "agent_logic", exit_code: 1 });
    d.record({ agent_id: "tester", task_id: "t1", error_kind: "agent_logic", exit_code: 1 });
    d.record({ agent_id: "reviewer", task_id: "t1", error_kind: "agent_logic", exit_code: 1 });
    expect(d.shouldBlock("t1")).toBe(false);
  });

  it("reset(task_id) clears the counter so a finished task does not bleed into a re-run", () => {
    const d = new DoomLoopDetector();
    const rec = { agent_id: "coder", task_id: "t1", error_kind: "agent_logic", exit_code: 1 };
    d.record(rec);
    d.record(rec);
    d.reset("t1");
    expect(d.shouldBlock("t1")).toBe(false);
    expect(d.countOf(rec)).toBe(0);
    expect(d.record(rec).blocked).toBe(false);
  });

  it("missing exit_code is its own bucket (e.g. validator failures)", () => {
    const d = new DoomLoopDetector();
    const rec = { agent_id: "coder", task_id: "t1", error_kind: "agent_logic" };
    expect(d.record(rec).count).toBe(1);
    expect(d.record(rec).count).toBe(2);
    expect(d.record(rec).blocked).toBe(true);
  });
});
