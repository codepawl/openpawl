import { describe, it, expect } from "vitest";
import { AgentRateLimiter } from "../../src/security/rate-limiter.js";

describe("AgentRateLimiter", () => {
  it("allows requests under limit", () => {
    const limiter = new AgentRateLimiter({ maxRequestsPerAgent: 5 });
    expect(limiter.checkLimit("coder")).toBe(true);
  });

  it("blocks after max requests", () => {
    const limiter = new AgentRateLimiter({ maxRequestsPerAgent: 3 });
    limiter.recordRequest("coder");
    limiter.recordRequest("coder");
    limiter.recordRequest("coder");
    expect(limiter.checkLimit("coder")).toBe(false);
  });

  it("getUsage returns correct counts", () => {
    const limiter = new AgentRateLimiter({ maxRequestsPerAgent: 10 });
    limiter.recordRequest("coder");
    limiter.recordRequest("coder");
    const usage = limiter.getUsage("coder");
    expect(usage.used).toBe(2);
    expect(usage.limit).toBe(10);
  });
});
