import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OpenpawlIgnore } from "../../src/onboard/openpawl-ignore.js";

describe("OpenpawlIgnore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-ignore-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("default patterns block node_modules", async () => {
    const ignore = new OpenpawlIgnore(tmpDir);
    await ignore.load();
    expect(ignore.isIgnored("node_modules/package/index.js")).toBe(true);
  });

  it("default patterns block .env", async () => {
    const ignore = new OpenpawlIgnore(tmpDir);
    await ignore.load();
    expect(ignore.isIgnored(".env")).toBe(true);
  });

  it("user patterns loaded from .openpawlignore", async () => {
    await writeFile(path.join(tmpDir, ".openpawlignore"), "secrets/\n*.secret.json\n");
    const ignore = new OpenpawlIgnore(tmpDir);
    await ignore.load();
    expect(ignore.isIgnored("secrets/api.json")).toBe(true);
    expect(ignore.isIgnored("data.secret.json")).toBe(true);
  });

  it("glob patterns work", async () => {
    const ignore = new OpenpawlIgnore(tmpDir);
    await ignore.load();
    expect(ignore.isIgnored("server.key")).toBe(true);
    expect(ignore.isIgnored("cert.pem")).toBe(true);
  });

  it("isIgnored returns false for normal source files", async () => {
    const ignore = new OpenpawlIgnore(tmpDir);
    await ignore.load();
    expect(ignore.isIgnored("src/auth.ts")).toBe(false);
    expect(ignore.isIgnored("README.md")).toBe(false);
  });

  it("missing .openpawlignore uses defaults only", async () => {
    const ignore = new OpenpawlIgnore(tmpDir);
    await ignore.load(); // No .openpawlignore file
    expect(ignore.getPatterns().length).toBeGreaterThan(0);
    expect(ignore.isIgnored("node_modules/x")).toBe(true);
    expect(ignore.isIgnored("src/index.ts")).toBe(false);
  });
});
