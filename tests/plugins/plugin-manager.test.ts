import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PluginManager } from "../../src/plugins/plugin-manager.js";

describe("PluginManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-plugin-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loadFromDirectory handles missing directory", async () => {
    const mgr = new PluginManager();
    await mgr.loadFromDirectory("/nonexistent");
    expect(mgr.getLoaded()).toHaveLength(0);
  });

  it("loadPlugin rejects invalid plugin", async () => {
    const mgr = new PluginManager();
    const result = await mgr.loadPlugin("/nonexistent/plugin.js");
    expect(result.isErr()).toBe(true);
  });

  it("unloadPlugin removes by name", () => {
    const mgr = new PluginManager();
    // Can't easily test with real module loading in unit test
    // but verify the API doesn't crash
    mgr.unloadPlugin("nonexistent");
    expect(mgr.getLoaded()).toHaveLength(0);
  });

  it("getLoaded returns empty initially", () => {
    const mgr = new PluginManager();
    expect(mgr.getLoaded()).toHaveLength(0);
  });
});
