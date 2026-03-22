import { describe, it, expect } from "vitest";
import { validateTemplate } from "@/templates/validator.js";

describe("validateTemplate", () => {
  const validTemplate = {
    id: "content-creator",
    name: "Content Creator Team",
    version: "0.0.1",
    author: "nxank4",
    description: "Research → Script → SEO → Review pipeline",
    tags: ["content", "youtube"],
    agents: [
      { role: "researcher", taskTypes: ["research"] },
      { role: "scriptwriter", taskTypes: ["writing"] },
    ],
  };

  it("accepts valid template", () => {
    const result = validateTemplate(validTemplate);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBe("content-creator");
  });

  it("accepts template with all optional fields", () => {
    const result = validateTemplate({
      ...validTemplate,
      defaultGoalTemplate: "Create {contentType} about {topic}",
      estimatedCostPerRun: 0.07,
      minRuns: 3,
      requiresWebhook: false,
      readme: "README.md",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects non-kebab-case id", () => {
    const result = validateTemplate({ ...validTemplate, id: "Content_Creator" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("rejects empty id", () => {
    const result = validateTemplate({ ...validTemplate, id: "" });
    expect(result.valid).toBe(false);
  });

  it("rejects description over 200 chars", () => {
    const result = validateTemplate({
      ...validTemplate,
      description: "x".repeat(201),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("200"))).toBe(true);
  });

  it("rejects more than 5 tags", () => {
    const result = validateTemplate({
      ...validTemplate,
      tags: ["a", "b", "c", "d", "e", "f"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("5"))).toBe(true);
  });

  it("rejects invalid semver version", () => {
    const result = validateTemplate({ ...validTemplate, version: "1.0" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("semver"))).toBe(true);
  });

  it("accepts valid semver with pre-release", () => {
    const result = validateTemplate({ ...validTemplate, version: "1.0.0-beta.1" });
    expect(result.valid).toBe(true);
  });

  it("rejects template with no agents", () => {
    const result = validateTemplate({ ...validTemplate, agents: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent"))).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = validateTemplate({ id: "test" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts agent with composition rules", () => {
    const result = validateTemplate({
      ...validTemplate,
      agents: [
        {
          role: "researcher",
          compositionRules: { required: true, includeKeywords: ["research"] },
        },
      ],
    });
    expect(result.valid).toBe(true);
  });
});
