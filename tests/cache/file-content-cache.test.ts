import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileContentCache } from "../../src/cache/file-content-cache.js";

describe("FileContentCache", () => {
  let tmpDir: string;
  let cache: FileContentCache;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-fcache-test-"));
    cache = new FileContentCache();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("mtime unchanged → hit", async () => {
    const fp = path.join(tmpDir, "test.ts");
    await writeFile(fp, "content");
    await cache.set(fp, "content");
    expect(await cache.get(fp)).not.toBeNull();
  });

  it("mtime changed → miss", async () => {
    const fp = path.join(tmpDir, "test.ts");
    await writeFile(fp, "old");
    await cache.set(fp, "old");
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(fp, "new");
    expect(await cache.get(fp)).toBeNull();
  });

  it("invalidate removes entry", async () => {
    const fp = path.join(tmpDir, "test.ts");
    await writeFile(fp, "content");
    await cache.set(fp, "content");
    cache.invalidate(fp);
    expect(await cache.get(fp)).toBeNull();
  });

  it("invalidateAll clears everything", async () => {
    const fp = path.join(tmpDir, "a.ts");
    await writeFile(fp, "a");
    await cache.set(fp, "a");
    cache.invalidateAll();
    expect(cache.getStats().entries).toBe(0);
  });
});
