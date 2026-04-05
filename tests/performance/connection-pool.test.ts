import { describe, it, expect } from "vitest";
import { ConnectionPool } from "../../src/performance/connection-pool.js";

describe("ConnectionPool", () => {
  it("getConnection returns agent for URL", () => {
    const pool = new ConnectionPool();
    const agent = pool.getConnection("https://api.anthropic.com");
    expect(agent).toBeDefined();
    pool.closeAll();
  });

  it("returns same agent for same URL", () => {
    const pool = new ConnectionPool();
    const a1 = pool.getConnection("https://api.anthropic.com");
    const a2 = pool.getConnection("https://api.anthropic.com");
    expect(a1).toBe(a2);
    pool.closeAll();
  });

  it("different URLs get different agents", () => {
    const pool = new ConnectionPool();
    const a1 = pool.getConnection("https://api.anthropic.com");
    const a2 = pool.getConnection("https://api.openai.com");
    expect(a1).not.toBe(a2);
    pool.closeAll();
  });

  it("closeAll destroys all agents", () => {
    const pool = new ConnectionPool();
    pool.getConnection("https://api.anthropic.com");
    pool.closeAll();
    // Getting again creates a new agent
    const agent = pool.getConnection("https://api.anthropic.com");
    expect(agent).toBeDefined();
    pool.closeAll();
  });
});
