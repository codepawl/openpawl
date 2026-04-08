/**
 * Bun test global setup (preloaded via bunfig.toml).
 */
import { afterEach, afterAll, mock } from "bun:test";

process.setMaxListeners(50);

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  mock.restore();
});
