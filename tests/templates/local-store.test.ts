import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalTemplateStore } from "@/templates/local-store.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = path.join(os.tmpdir(), "teamclaw-test-store-" + Date.now());

// Override homedir for tests
const originalHomedir = os.homedir;

describe("LocalTemplateStore", () => {
  beforeEach(() => {
    // Use a temp directory to avoid polluting real ~/.teamclaw
    process.env.HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHomedir();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  const sampleTemplate = {
    id: "test-template",
    name: "Test Template",
    version: "0.0.1",
    author: "tester",
    description: "A test template",
    tags: ["test"],
    agents: [{ role: "worker-bot" }],
  };

  it("installs template to correct path", async () => {
    const store = new LocalTemplateStore();
    await store.install(sampleTemplate);

    const templatePath = path.join(
      TEST_DIR,
      ".teamclaw",
      "templates",
      "installed",
      "test-template",
      "template.json",
    );
    expect(existsSync(templatePath)).toBe(true);
  });

  it("correctly reports isInstalled", async () => {
    const store = new LocalTemplateStore();

    expect(await store.isInstalled("test-template")).toBe(false);
    await store.install(sampleTemplate);
    expect(await store.isInstalled("test-template")).toBe(true);
  });

  it("gets installed template", async () => {
    const store = new LocalTemplateStore();
    await store.install(sampleTemplate);

    const result = await store.get("test-template");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("test-template");
    expect(result!.installedAt).toBeTypeOf("number");
    expect(result!.installedVersion).toBe("0.0.1");
  });

  it("returns null for non-existent template", async () => {
    const store = new LocalTemplateStore();
    const result = await store.get("non-existent");
    expect(result).toBeNull();
  });

  it("lists all installed templates", async () => {
    const store = new LocalTemplateStore();
    await store.install(sampleTemplate);
    await store.install({ ...sampleTemplate, id: "another-template", name: "Another" });

    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list.map((t) => t.id).sort()).toEqual(["another-template", "test-template"]);
  });

  it("uninstalls template", async () => {
    const store = new LocalTemplateStore();
    await store.install(sampleTemplate);

    expect(await store.isInstalled("test-template")).toBe(true);
    const removed = await store.uninstall("test-template");
    expect(removed).toBe(true);
    expect(await store.isInstalled("test-template")).toBe(false);
  });

  it("returns false when uninstalling non-existent template", async () => {
    const store = new LocalTemplateStore();
    const removed = await store.uninstall("non-existent");
    expect(removed).toBe(false);
  });

  it("update replaces existing template", async () => {
    const store = new LocalTemplateStore();
    await store.install(sampleTemplate);

    const updated = { ...sampleTemplate, version: "2.0.0", name: "Updated Template" };
    await store.install(updated);

    const result = await store.get("test-template");
    expect(result!.installedVersion).toBe("2.0.0");
    expect(result!.name).toBe("Updated Template");
  });
});
