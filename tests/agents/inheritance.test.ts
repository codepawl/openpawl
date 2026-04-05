import { describe, it, expect } from "vitest";
import { InheritanceResolver } from "../../src/agents/customization/inheritance.js";
import type { AgentYaml, AgentSource } from "../../src/agents/customization/types.js";
import type { AgentDefinition } from "../../src/router/router-types.js";

const coderDef: AgentDefinition = {
  id: "coder",
  name: "Coder",
  description: "Writes code",
  capabilities: ["code_write", "code_edit"],
  defaultTools: ["file_read", "file_write"],
  modelTier: "primary",
  systemPrompt: "You are a coder.",
  canCollaborate: true,
  maxConcurrent: 3,
  triggerPatterns: ["\\bwrite\\b"],
};

const builtIns = new Map<string, AgentDefinition>([["coder", coderDef]]);
const source: AgentSource = { type: "user", filePath: "/test" };

describe("InheritanceResolver", () => {
  it("child inherits parent capabilities", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "senior-coder", name: "Senior Coder", description: "Better", extends: "coder" };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().capabilities).toContain("code_write");
  });

  it("child overrides parent model tier", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "fast-coder", name: "Fast", description: "F", extends: "coder", model: { tier: "fast" } };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result._unsafeUnwrap().modelTier).toBe("fast");
  });

  it("child tools.exclude blocks parent tools", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "safe-coder", name: "Safe", description: "S", extends: "coder", tools: { exclude: ["file_write"] } };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result._unsafeUnwrap().defaultTools).not.toContain("file_write");
    expect(result._unsafeUnwrap().defaultTools).toContain("file_read");
  });

  it("prompt.rules merge (child + parent)", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "strict-coder", name: "Strict", description: "S", extends: "coder", prompt: { rules: ["Use strict mode"] } };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result._unsafeUnwrap().rawYaml.prompt?.rules).toContain("Use strict mode");
  });

  it("prompt.system replaces parent entirely", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "custom", name: "Custom", description: "C", extends: "coder", prompt: { system: "I am custom." } };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result._unsafeUnwrap().systemPrompt).toBe("I am custom.");
    expect(result._unsafeUnwrap().systemPrompt).not.toContain("You are a coder");
  });

  it("prompt.prepend goes before parent prompt", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "prefix", name: "P", description: "P", extends: "coder", prompt: { prepend: "IMPORTANT:" } };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result._unsafeUnwrap().systemPrompt.startsWith("IMPORTANT:")).toBe(true);
  });

  it("circular inheritance detected", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yamls = new Map<string, AgentYaml>([
      ["a", { id: "a", name: "A", description: "A", extends: "b" }],
      ["b", { id: "b", name: "B", description: "B", extends: "a" }],
    ]);

    const result = resolver.resolve(yamls.get("a")!, yamls, source);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("circular_inheritance");
  });

  it("missing parent returns error", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "orphan", name: "Orphan", description: "O", extends: "nonexistent" };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result.isErr()).toBe(true);
  });

  it("extends built-in agent works", () => {
    const resolver = new InheritanceResolver(builtIns);
    const yaml: AgentYaml = { id: "my-coder", name: "My Coder", description: "Mine", extends: "coder" };

    const result = resolver.resolve(yaml, new Map(), source);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().extendsChain).toContain("coder");
  });
});
