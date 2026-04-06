/**
 * Vitest global setup.
 *
 * Keep unit tests deterministic regardless of developer-local `.env`.
 * Clear mocks between tests and restore after each file to prevent
 * memory leaks in worker processes.
 */

import { afterEach, afterAll, vi } from "vitest";

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});
