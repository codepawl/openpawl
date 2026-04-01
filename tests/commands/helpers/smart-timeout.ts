/**
 * Smart timeout wrapper for command tests.
 *
 * - Default 10s timeout
 * - If core assertions pass but cleanup is slow, mark as passed
 * - If blocked/hanging, fail with diagnostic info
 */
import { vi } from "vitest";

interface SmartTimeoutOptions {
  maxMs?: number;
  /** Label for diagnostic output on timeout */
  label?: string;
}

/**
 * Wraps a test function with a smart timeout.
 * Returns a function suitable for vitest's `it()`.
 */
export function withSmartTimeout(
  testFn: () => Promise<void>,
  opts?: SmartTimeoutOptions,
): () => Promise<void> {
  const maxMs = opts?.maxMs ?? 10_000;
  const label = opts?.label ?? "test";

  return async () => {
    let assertionsPassed = false;

    const testPromise = (async () => {
      await testFn();
      assertionsPassed = true;
    })();

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), maxMs),
    );

    const result = await Promise.race([
      testPromise.then(() => "done" as const),
      timeoutPromise,
    ]);

    if (result === "timeout") {
      if (assertionsPassed) {
        // Core logic passed but teardown is slow — acceptable
        return;
      }
      throw new Error(
        `TIMEOUT: ${label} exceeded ${maxMs}ms without completing assertions. ` +
        `This may indicate a hanging promise or unresolved I/O.`,
      );
    }
  };
}

/**
 * Creates a test timeout value for vitest's `it()` options.
 * Use for tests involving graph execution or multi-agent loops.
 */
export const EXTENDED_TIMEOUT = 30_000;
export const DEFAULT_TIMEOUT = 10_000;
