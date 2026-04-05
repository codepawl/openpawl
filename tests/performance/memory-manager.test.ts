import { describe, it, expect } from "vitest";
import { MemoryManager } from "../../src/performance/memory-manager.js";

describe("MemoryManager", () => {
  it("getUsage returns all fields with positive values", () => {
    const mgr = new MemoryManager();
    const usage = mgr.getUsage();
    expect(usage.rss).toBeGreaterThan(0);
    expect(usage.heapUsed).toBeGreaterThan(0);
    expect(usage.heapTotal).toBeGreaterThan(0);
    expect(typeof usage.external).toBe("number");
    expect(typeof usage.arrayBuffers).toBe("number");
  });

  it("startMonitoring does not throw", () => {
    const mgr = new MemoryManager();
    mgr.startMonitoring();
    mgr.stopMonitoring();
  });

  it("stopMonitoring clears interval", () => {
    const mgr = new MemoryManager();
    mgr.startMonitoring();
    mgr.stopMonitoring();
    // Should not throw on double stop
    mgr.stopMonitoring();
  });
});
