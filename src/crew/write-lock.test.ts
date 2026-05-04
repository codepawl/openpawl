import { describe, it, expect } from "bun:test";

import {
  WriteLockManager,
  WriteLockReleaseError,
  WriteLockTimeoutError,
} from "./write-lock.js";

describe("WriteLockManager", () => {
  it("acquires a free lock and releases it", async () => {
    const m = new WriteLockManager();
    await m.acquire("file:/foo.ts", "coder");
    expect(m.isHeld("file:/foo.ts")).toBe(true);
    expect(m.holderOf("file:/foo.ts")).toBe("coder");
    m.release("file:/foo.ts", "coder");
    expect(m.isHeld("file:/foo.ts")).toBe(false);
  });

  it("treats same-agent re-acquire as a no-op (reentrant)", async () => {
    const m = new WriteLockManager();
    await m.acquire("file:/foo.ts", "coder");
    await m.acquire("file:/foo.ts", "coder");
    await m.acquire("file:/foo.ts", "coder");
    expect(m.queueDepth("file:/foo.ts")).toBe(0);
    m.release("file:/foo.ts", "coder");
    expect(m.isHeld("file:/foo.ts")).toBe(false);
  });

  it("tryAcquire grants when free", () => {
    const m = new WriteLockManager();
    const r = m.tryAcquire("k", "a");
    expect(r.granted).toBe(true);
    expect(m.holderOf("k")).toBe("a");
  });

  it("tryAcquire denies when held by a different agent and reports holder + queue depth", async () => {
    const m = new WriteLockManager();
    await m.acquire("k", "a");
    void m.acquire("k", "b").catch(() => {});
    await Promise.resolve();

    const r = m.tryAcquire("k", "c");
    expect(r.granted).toBe(false);
    if (!r.granted) {
      expect(r.holder_agent).toBe("a");
      expect(r.queued_count).toBe(1);
    }
  });

  it("conflict: second agent waits until release, then acquires", async () => {
    const m = new WriteLockManager();
    await m.acquire("k", "a");

    let bAcquired = false;
    const bPromise = m.acquire("k", "b").then(() => {
      bAcquired = true;
    });
    await Promise.resolve();
    expect(bAcquired).toBe(false);

    m.release("k", "a");
    await bPromise;
    expect(bAcquired).toBe(true);
    expect(m.holderOf("k")).toBe("b");
    m.release("k", "b");
  });

  it("timeout: rejects with WriteLockTimeoutError when wait exceeds budget", async () => {
    const m = new WriteLockManager();
    await m.acquire("k", "a");

    const start = Date.now();
    let caught: unknown = null;
    try {
      await m.acquire("k", "b", 50);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(WriteLockTimeoutError);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(m.queueDepth("k")).toBe(0);
    m.release("k", "a");
  });

  it("release by non-holder throws WriteLockReleaseError", async () => {
    const m = new WriteLockManager();
    await m.acquire("k", "a");
    expect(() => m.release("k", "b")).toThrow(WriteLockReleaseError);
    m.release("k", "a");
  });

  it("releaseAllFor unlocks every lock owned by an agent", async () => {
    const m = new WriteLockManager();
    await m.acquire("file:/a.ts", "coder");
    await m.acquire("file:/b.ts", "coder");
    await m.acquire("artifact:s1", "coder");

    const released = m.releaseAllFor("coder").sort();
    expect(released).toEqual(["artifact:s1", "file:/a.ts", "file:/b.ts"]);
    expect(m.isHeld("file:/a.ts")).toBe(false);
    expect(m.isHeld("file:/b.ts")).toBe(false);
    expect(m.isHeld("artifact:s1")).toBe(false);
  });

  it("hands off to next queued waiter on release", async () => {
    const m = new WriteLockManager();
    await m.acquire("k", "a");
    const bPromise = m.acquire("k", "b");
    const cPromise = m.acquire("k", "c");
    await Promise.resolve();
    expect(m.queueDepth("k")).toBe(2);

    m.release("k", "a");
    await bPromise;
    expect(m.holderOf("k")).toBe("b");
    expect(m.queueDepth("k")).toBe(1);

    m.release("k", "b");
    await cPromise;
    expect(m.holderOf("k")).toBe("c");
    m.release("k", "c");
  });
});
