import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { analyzeProject } from "../../src/onboard/project-analyzer.js";

describe("analyzeProject", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-proj-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects TypeScript from tsconfig.json", async () => {
    await writeFile(path.join(tmpDir, "tsconfig.json"), "{}");
    await writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const result = await analyzeProject(tmpDir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().language).toBe("typescript");
  });

  it("detects Express from package.json", async () => {
    await writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "api",
      dependencies: { express: "^4.18.0" },
    }));
    const result = await analyzeProject(tmpDir);
    expect(result._unsafeUnwrap().framework).toBe("express");
  });

  it("detects vitest from devDependencies", async () => {
    await writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "test",
      devDependencies: { vitest: "^2.0.0" },
    }));
    const result = await analyzeProject(tmpDir);
    expect(result._unsafeUnwrap().testRunner).toBe("vitest");
  });

  it("detects large project from file count", async () => {
    await writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "big" }));
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    // Create many files
    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(tmpDir, "src", `file${i}.ts`), `export const x${i} = ${i};`);
    }
    const result = await analyzeProject(tmpDir);
    expect(result._unsafeUnwrap().estimatedSize).toBe("medium"); // ~60 files
  });

  it("handles empty directory gracefully", async () => {
    const result = await analyzeProject(tmpDir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().type).toBeNull();
  });
});
