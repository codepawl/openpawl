import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    onboard: "src/onboard/index.tsx",
  },
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  outDir: "dist",
  shims: true,
  // Keep bundling deterministic and avoid noisy post-tree-shake "unused import"
  // warnings emitted for shared externals across multi-entry CLI bundles.
  treeshake: false,
});
