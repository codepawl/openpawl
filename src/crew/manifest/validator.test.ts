import { describe, expect, it } from "bun:test";

import { validateManifest } from "./validator.js";
import type { CrewManifest } from "./types.js";

function baseManifest(overrides: Partial<CrewManifest> = {}): unknown {
  return {
    name: "team",
    description: "A small team",
    version: "1.0.0",
    agents: [
      {
        id: "coder",
        name: "Coder",
        description: "writes code",
        prompt: "You are the coder agent.",
        tools: ["file_read", "file_write"],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        description: "reviews code",
        prompt: "You are the reviewer agent.",
        tools: ["file_read"],
      },
    ],
    constraints: {
      min_agents: 2,
      max_agents: 10,
      recommended_range: [3, 5],
      required_roles: [],
    },
    ...overrides,
  };
}

describe("validateManifest", () => {
  it("accepts a valid 2-agent manifest with a recommended-range warning", () => {
    const r = validateManifest(baseManifest());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    // 2 agents is below recommended [3,5]
    expect(r.warnings.some((w) => w.message.includes("recommended"))).toBe(true);
  });

  it("rejects duplicate agent ids", () => {
    const m = baseManifest({
      agents: [
        {
          id: "coder",
          name: "Coder",
          description: "a",
          prompt: "Prompt one.",
          tools: ["file_read"],
        },
        {
          id: "coder",
          name: "Coder Two",
          description: "b",
          prompt: "Prompt two.",
          tools: ["file_read"],
        },
      ],
    } as unknown as Partial<CrewManifest>);
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("duplicate"))).toBe(true);
  });

  it("rejects agent count below min_agents", () => {
    const m = baseManifest({
      agents: [
        {
          id: "solo",
          name: "Solo",
          description: "alone",
          prompt: "Only agent.",
          tools: ["file_read"],
        },
      ],
    } as unknown as Partial<CrewManifest>);
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
  });

  it("warns when crew has no write-capable agent", () => {
    const m = baseManifest({
      agents: [
        {
          id: "a",
          name: "A",
          description: "a",
          prompt: "Read-only A.",
          tools: ["file_read"],
        },
        {
          id: "b",
          name: "B",
          description: "b",
          prompt: "Read-only B.",
          tools: ["file_read"],
        },
      ],
    } as unknown as Partial<CrewManifest>);
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.message.includes("file_write"))).toBe(true);
  });

  it("rejects unsafe write_scope globs (escape, absolute, weird chars)", () => {
    const m = baseManifest({
      agents: [
        {
          id: "tester",
          name: "Tester",
          description: "writes tests",
          prompt: "Tester prompt.",
          tools: ["file_write"],
          write_scope: ["../escape/*.ts"],
        },
        {
          id: "coder",
          name: "Coder",
          description: "writes code",
          prompt: "Coder prompt.",
          tools: ["file_write"],
          write_scope: ["/abs/path/*.ts"],
        },
      ],
    } as unknown as Partial<CrewManifest>);
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes(".."))).toBe(true);
    expect(r.errors.some((e) => e.message.includes("repo-relative"))).toBe(true);
  });

  it("warns when a non-write-capable agent has a write_scope", () => {
    const m = baseManifest({
      agents: [
        {
          id: "reviewer",
          name: "Reviewer",
          description: "no writes",
          prompt: "Reviewer prompt.",
          tools: ["file_read"],
          write_scope: ["**/*.ts"],
        },
        {
          id: "coder",
          name: "Coder",
          description: "writes code",
          prompt: "Coder prompt.",
          tools: ["file_write"],
        },
      ],
    } as unknown as Partial<CrewManifest>);
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
    expect(
      r.warnings.some((w) => w.agent_id === "reviewer" && w.message.includes("write_scope")),
    ).toBe(true);
  });

  it("accepts the recommended 4-agent shape with no warnings", () => {
    const m = baseManifest({
      agents: [
        { id: "p", name: "P", description: "p", prompt: "Planner prompt.", tools: ["file_read"] },
        { id: "c", name: "C", description: "c", prompt: "Coder prompt.", tools: ["file_write"] },
        { id: "r", name: "R", description: "r", prompt: "Reviewer prompt.", tools: ["file_read"] },
        { id: "t", name: "T", description: "t", prompt: "Tester prompt.", tools: ["file_write"], write_scope: ["**/*.test.ts"] },
      ],
    } as unknown as Partial<CrewManifest>);
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});
