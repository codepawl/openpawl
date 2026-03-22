import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TemplatePublisher } from "@/templates/publisher.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = path.join(os.tmpdir(), "teamclaw-test-publisher-" + Date.now());

describe("TemplatePublisher", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  const validTemplate = {
    id: "test-template",
    name: "Test Template",
    version: "0.0.1",
    author: "tester",
    description: "A test template for testing",
    tags: ["test"],
    agents: [{ role: "worker-bot" }],
  };

  it("validates before attempting PR creation", async () => {
    const templatePath = path.join(TEST_DIR, "template.json");
    const invalidTemplate = { ...validTemplate, id: "INVALID_ID" };
    writeFileSync(templatePath, JSON.stringify(invalidTemplate));

    const publisher = new TemplatePublisher();
    const result = await publisher.publish(templatePath);

    expect(result.success).toBe(false);
    expect(result.method).toBe("none");
    expect(result.error).toContain("validation failed");
  });

  it("fails gracefully with non-existent file", async () => {
    const publisher = new TemplatePublisher();
    const result = await publisher.publish("/tmp/nonexistent.json");

    expect(result.success).toBe(false);
    expect(result.method).toBe("none");
    expect(result.error).toContain("Failed to read template");
  });

  it("fails validation for invalid JSON", async () => {
    const templatePath = path.join(TEST_DIR, "bad.json");
    writeFileSync(templatePath, "not json");

    const publisher = new TemplatePublisher();
    const result = await publisher.publish(templatePath);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("correctly formats gh CLI command", () => {
    const publisher = new TemplatePublisher();
    const cmd = publisher.getGhCommand(validTemplate as any);

    expect(cmd).toContain("gh pr create");
    expect(cmd).toContain("nxank4/teamclaw-templates");
    expect(cmd).toContain("test-template");
  });

  it("uses custom repo config", () => {
    const publisher = new TemplatePublisher({ repo: "custom/repo" });
    const cmd = publisher.getGhCommand(validTemplate as any);

    expect(cmd).toContain("custom/repo");
  });
});

describe("Seed templates validation", () => {
  it("all seed templates pass validation", async () => {
    const { validateTemplate } = await import("@/templates/validator.js");
    const { getAllSeedTemplates } = await import("@/templates/seeds/index.js");

    const seeds = getAllSeedTemplates();
    expect(seeds.length).toBeGreaterThan(0);

    for (const seed of seeds) {
      const result = validateTemplate(seed);
      expect(result.valid, `Seed template "${seed.id}" should be valid: ${result.errors.join(", ")}`).toBe(true);
    }
  });
});
