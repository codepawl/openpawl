import { describe, it, expect } from "vitest";
import { AgentPromptBuilder } from "../../src/agents/customization/prompt-builder.js";
import type { ResolvedAgent } from "../../src/agents/customization/types.js";

function makeAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    id: "test",
    name: "Test Agent",
    description: "A test agent",
    source: { type: "user", filePath: "/test" },
    capabilities: [],
    defaultTools: [],
    excludedTools: [],
    modelTier: "primary",
    systemPrompt: "You are Test Agent.",
    triggerPatterns: [],
    canCollaborate: true,
    maxConcurrent: 2,
    confirmDestructive: true,
    extendsChain: [],
    rawYaml: { id: "test", name: "Test Agent", description: "A test agent" },
    ...overrides,
  };
}

describe("AgentPromptBuilder", () => {
  const builder = new AgentPromptBuilder();

  it("builds base prompt from system field", () => {
    const prompt = builder.build(makeAgent({ systemPrompt: "I am a custom agent." }));
    expect(prompt).toContain("I am a custom agent.");
  });

  it("injects rules as bullet points", () => {
    const agent = makeAgent({
      rawYaml: { id: "test", name: "T", description: "D", prompt: { rules: ["Rule 1", "Rule 2"] } },
    });
    const prompt = builder.build(agent);
    expect(prompt).toContain("- Rule 1");
    expect(prompt).toContain("- Rule 2");
    expect(prompt).toContain("Rules you must follow");
  });

  it("injects personality traits and opinions", () => {
    const agent = makeAgent({
      personality: {
        traits: ["thorough", "pragmatic"],
        tone: "direct",
        verbosity: "concise",
        opinions: [{ topic: "testing", stance: "always test", strength: "strong" }],
        pushbackTriggers: [],
        catchphrases: [],
      },
    });
    const prompt = builder.build(agent);
    expect(prompt).toContain("thorough");
    expect(prompt).toContain("testing");
    expect(prompt).toContain("always test");
  });

  it("buildWithContext adds session info", () => {
    const prompt = builder.buildWithContext(makeAgent(), {
      sessionTitle: "Fix auth",
      workingDirectory: "/home/user/project",
      projectType: "node",
    });
    expect(prompt).toContain("Fix auth");
    expect(prompt).toContain("/home/user/project");
    expect(prompt).toContain("node");
  });

  it("handles empty personality gracefully", () => {
    const prompt = builder.build(makeAgent({ personality: undefined }));
    expect(prompt).toBeDefined();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("handles agent with no prompt overrides", () => {
    const prompt = builder.build(makeAgent());
    expect(prompt).toContain("Test Agent");
  });
});
