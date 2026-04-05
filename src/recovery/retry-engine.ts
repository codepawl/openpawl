/**
 * Retry with exponential backoff, jitter, and circuit breaker.
 */

import { Result } from "neverthrow";
import type { RetryStrategy, CircuitBreakerState } from "./types.js";

export class RetryEngine {
  async execute<T>(
    operation: () => Promise<Result<T, unknown>>,
    strategy: RetryStrategy,
    options?: {
      onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<Result<T, unknown>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= strategy.maxAttempts; attempt++) {
      if (options?.abortSignal?.aborted) break;

      const result = await operation();
      if (result.isOk()) return result;

      lastError = result.error;

      if (attempt < strategy.maxAttempts) {
        const delay = this.calculateDelay(attempt, strategy);
        options?.onRetry?.(attempt, lastError, delay);
        await sleep(delay, options?.abortSignal);
      }
    }

    // Return last error
    return { isOk: () => false, isErr: () => true, error: lastError } as Result<T, unknown>;
  }

  calculateDelay(attempt: number, strategy: RetryStrategy): number {
    let delay = Math.min(
      strategy.backoffMs * Math.pow(2, attempt - 1),
      strategy.maxBackoffMs,
    );
    if (strategy.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }
    return Math.round(delay);
  }
}

export class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>();

  constructor(
    private failureThreshold = 5,
    private resetTimeoutMs = 60_000,
  ) {}

  canExecute(provider: string): boolean {
    const state = this.getState(provider);
    if (state.state === "closed") return true;
    if (state.state === "open") {
      if (Date.now() >= state.openUntil) {
        state.state = "half-open";
        return true;
      }
      return false;
    }
    // half-open: allow one request
    return true;
  }

  recordSuccess(provider: string): void {
    const state = this.getState(provider);
    state.state = "closed";
    state.failureCount = 0;
  }

  recordFailure(provider: string): void {
    const state = this.getState(provider);
    state.failureCount++;
    state.lastFailureAt = Date.now();

    if (state.failureCount >= this.failureThreshold) {
      state.state = "open";
      state.openUntil = Date.now() + this.resetTimeoutMs;
    }
  }

  getState(provider: string): CircuitBreakerState {
    let state = this.states.get(provider);
    if (!state) {
      state = { provider, state: "closed", failureCount: 0, lastFailureAt: 0, openUntil: 0 };
      this.states.set(provider, state);
    }
    return state;
  }

  reset(provider: string): void {
    this.states.delete(provider);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
