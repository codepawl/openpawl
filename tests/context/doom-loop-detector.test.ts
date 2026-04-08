import { describe, it, expect } from "bun:test";
import { DoomLoopDetector } from "../../src/context/doom-loop-detector.js";

const AGENT = "coder";

describe("DoomLoopDetector", () => {
  describe("track verdicts", () => {
    it("allows 1st and 2nd identical calls", () => {
      const d = new DoomLoopDetector();
      const params = { path: "src/missing.ts" };

      const v1 = d.track(AGENT, "file_read", params);
      expect(v1.action).toBe("allow");

      const v2 = d.track(AGENT, "file_read", params);
      expect(v2.action).toBe("allow");
    });

    it("warns on 3rd identical call", () => {
      const d = new DoomLoopDetector();
      const params = { path: "src/missing.ts" };

      d.track(AGENT, "file_read", params);
      d.track(AGENT, "file_read", params);
      const v3 = d.track(AGENT, "file_read", params);

      expect(v3.action).toBe("warn");
      expect(v3).toHaveProperty("message");
      expect(v3).toHaveProperty("count", 3);
      expect((v3 as { message: string }).message).toContain("file_read");
      expect((v3 as { message: string }).message).toContain("3 times");
    });

    it("blocks on 4th identical call", () => {
      const d = new DoomLoopDetector();
      const params = { path: "src/missing.ts" };

      d.track(AGENT, "file_read", params);
      d.track(AGENT, "file_read", params);
      d.track(AGENT, "file_read", params);
      const v4 = d.track(AGENT, "file_read", params);

      expect(v4.action).toBe("block");
      expect(v4).toHaveProperty("count", 4);
      expect((v4 as { message: string }).message).toContain("blocked");
      expect((v4 as { message: string }).message).toContain("file_read");
    });

    it("continues blocking on 5th+ identical call", () => {
      const d = new DoomLoopDetector();
      const params = { path: "src/missing.ts" };

      for (let i = 0; i < 4; i++) d.track(AGENT, "file_read", params);
      const v5 = d.track(AGENT, "file_read", params);

      expect(v5.action).toBe("block");
      expect(v5).toHaveProperty("count", 5);
    });
  });

  describe("fingerprinting", () => {
    it("treats different params as different fingerprints", () => {
      const d = new DoomLoopDetector();

      d.track(AGENT, "file_read", { path: "a.ts" });
      d.track(AGENT, "file_read", { path: "a.ts" });
      d.track(AGENT, "file_read", { path: "b.ts" }); // different param

      // The 3rd call has a different fingerprint, so it resets the consecutive count
      const stats = d.getStats();
      expect(stats.uniqueFingerprints).toBe(2);
    });

    it("same tool with different params does not trigger loop", () => {
      const d = new DoomLoopDetector();

      d.track(AGENT, "file_read", { path: "a.ts" });
      d.track(AGENT, "file_read", { path: "b.ts" });
      const v = d.track(AGENT, "file_read", { path: "c.ts" });

      expect(v.action).toBe("allow");
    });

    it("JSON key ordering does not affect hash", () => {
      const d = new DoomLoopDetector();

      const hash1 = d.fingerprint("tool", { a: 1, b: 2 });
      const hash2 = d.fingerprint("tool", { b: 2, a: 1 });

      expect(hash1).toBe(hash2);
    });

    it("different tools with same params have different hashes", () => {
      const d = new DoomLoopDetector();

      const hash1 = d.fingerprint("file_read", { path: "x.ts" });
      const hash2 = d.fingerprint("file_write", { path: "x.ts" });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("sliding window", () => {
    it("evicts entries beyond 20 calls", () => {
      const d = new DoomLoopDetector();

      // Fill 20 unique calls
      for (let i = 0; i < 20; i++) {
        d.track(AGENT, "shell_exec", { command: `cmd-${i}` });
      }

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(20);

      // Add one more — should evict the oldest
      d.track(AGENT, "shell_exec", { command: "cmd-20" });
      const stats2 = d.getStats();
      expect(stats2.totalCalls).toBe(20); // still 20, not 21
    });

    it("eviction prevents false positives from old calls", () => {
      const d = new DoomLoopDetector();

      // Call file_read 2 times
      d.track(AGENT, "file_read", { path: "old.ts" });
      d.track(AGENT, "file_read", { path: "old.ts" });

      // Push 20 different calls to evict the old ones
      for (let i = 0; i < 20; i++) {
        d.track(AGENT, "shell_exec", { command: `cmd-${i}` });
      }

      // Call file_read again — should be treated as 1st call (old ones evicted)
      const v = d.track(AGENT, "file_read", { path: "old.ts" });
      expect(v.action).toBe("allow");
    });
  });

  describe("reset", () => {
    it("clears all state when called without agentId", () => {
      const d = new DoomLoopDetector();

      d.track("agent1", "file_read", { path: "a.ts" });
      d.track("agent2", "file_read", { path: "b.ts" });

      d.reset();

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.agents).toBe(0);
    });

    it("clears only the specified agent when called with agentId", () => {
      const d = new DoomLoopDetector();

      d.track("agent1", "file_read", { path: "a.ts" });
      d.track("agent2", "file_read", { path: "b.ts" });

      d.reset("agent1");

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.agents).toBe(1);
    });

    it("resets consecutive count so next call is allow", () => {
      const d = new DoomLoopDetector();

      d.track(AGENT, "file_read", { path: "a.ts" });
      d.track(AGENT, "file_read", { path: "a.ts" });
      d.track(AGENT, "file_read", { path: "a.ts" }); // warn

      d.reset();

      const v = d.track(AGENT, "file_read", { path: "a.ts" });
      expect(v.action).toBe("allow");
    });
  });

  describe("per-agent isolation", () => {
    it("tracks agents independently", () => {
      const d = new DoomLoopDetector();
      const params = { path: "shared.ts" };

      // Agent 1 calls 3 times → warn
      d.track("agent1", "file_read", params);
      d.track("agent1", "file_read", params);
      const v1 = d.track("agent1", "file_read", params);
      expect(v1.action).toBe("warn");

      // Agent 2 calls same tool+params — should be independent
      const v2 = d.track("agent2", "file_read", params);
      expect(v2.action).toBe("allow");
    });
  });

  describe("getStats", () => {
    it("returns correct counts", () => {
      const d = new DoomLoopDetector();

      d.track("a1", "file_read", { path: "x.ts" });
      d.track("a1", "file_read", { path: "y.ts" });
      d.track("a2", "shell_exec", { command: "ls" });

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(3);
      expect(stats.uniqueFingerprints).toBe(3);
      expect(stats.agents).toBe(2);
    });
  });

  describe("consecutive counting", () => {
    it("resets consecutive count when a different call intervenes", () => {
      const d = new DoomLoopDetector();
      const params = { path: "a.ts" };

      d.track(AGENT, "file_read", params); // 1st
      d.track(AGENT, "file_read", params); // 2nd consecutive
      d.track(AGENT, "shell_exec", { command: "ls" }); // breaks the streak
      const v = d.track(AGENT, "file_read", params); // 1st consecutive again

      expect(v.action).toBe("allow");
    });
  });
});
