import { describe, it, expect, vi } from "vitest";
import { ok, err } from "neverthrow";
import { RetryEngine, CircuitBreaker } from "../../src/recovery/retry-engine.js";
import type { RetryStrategy } from "../../src/recovery/types.js";

describe("RetryEngine", () => {
  const engine = new RetryEngine();
  const strategy: RetryStrategy = { type: "retry", maxAttempts: 3, backoffMs: 10, maxBackoffMs: 100, jitter: false };

  it("retries on first failure, succeeds on second", async () => {
    let attempt = 0;
    const result = await engine.execute(async () => {
      attempt++;
      return attempt >= 2 ? ok("success") : err("fail");
    }, strategy);
    expect(result.isOk()).toBe(true);
    expect(attempt).toBe(2);
  });

  it("stops after maxAttempts exceeded", async () => {
    let attempts = 0;
    const result = await engine.execute(async () => {
      attempts++;
      return err("always fails");
    }, strategy);
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(3);
  });

  it("exponential backoff: attempt 2 = 2x base", () => {
    const delay1 = engine.calculateDelay(1, { ...strategy, jitter: false });
    const delay2 = engine.calculateDelay(2, { ...strategy, jitter: false });
    expect(delay2).toBe(delay1 * 2);
  });

  it("respects maxBackoffMs ceiling", () => {
    const delay = engine.calculateDelay(10, { ...strategy, maxBackoffMs: 50, jitter: false });
    expect(delay).toBeLessThanOrEqual(50);
  });

  it("jitter varies delay between 50-100%", () => {
    const delays = Array.from({ length: 20 }, () =>
      engine.calculateDelay(2, { ...strategy, jitter: true }),
    );
    const min = Math.min(...delays);
    const max = Math.max(...delays);
    expect(max).toBeGreaterThan(min); // Should vary
  });

  it("successful operation returns ok on first try", async () => {
    let calls = 0;
    const result = await engine.execute(async () => { calls++; return ok("done"); }, strategy);
    expect(result.isOk()).toBe(true);
    expect(calls).toBe(1);
  });

  it("onRetry callback called", async () => {
    const retries: number[] = [];
    await engine.execute(
      async () => err("fail"),
      strategy,
      { onRetry: (attempt) => retries.push(attempt) },
    );
    expect(retries).toEqual([1, 2]);
  });
});

describe("CircuitBreaker", () => {
  it("closed state allows execution", () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.canExecute("test")).toBe(true);
  });

  it("opens after failure threshold", () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordFailure("test");
    expect(cb.canExecute("test")).toBe(false);
  });

  it("success closes the circuit", () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure("test");
    cb.recordFailure("test");
    cb.recordSuccess("test");
    expect(cb.getState("test").failureCount).toBe(0);
  });

  it("reset clears state", () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure("test");
    cb.reset("test");
    expect(cb.canExecute("test")).toBe(true);
  });
});
