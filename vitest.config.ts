import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 10_000,
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/web/client/**",
        "**/*.d.ts",
        "**/index.ts",
        "src/cli.ts",
      ],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        // Floor = actual coverage minus 2% (ratchet — prevents regression)
        // Measured 2026-03-31: statements=47.66%, branches=73.23%, functions=66.5%, lines=47.66%
        lines: 45,
        functions: 64,
        branches: 71,
        statements: 45,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
