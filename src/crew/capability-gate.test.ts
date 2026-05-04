import { describe, expect, it } from "bun:test";

import { formatDenialForLLM, gateToolCall } from "./capability-gate.js";
import type { AgentDefinition } from "./manifest/types.js";

function agent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: "tester",
    name: "Tester",
    description: "writes tests",
    prompt: "You are the tester.",
    tools: ["file_read", "file_write", "shell_exec"],
    ...overrides,
  };
}

describe("gateToolCall — tool allowlist", () => {
  it("rejects a tool not in the agent's tools list", () => {
    const a = agent({ tools: ["file_read"] });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: { path: "src/foo.ts" },
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe("tool_not_in_allowlist");
      expect(r.message).toContain("file_write");
      expect(r.message).toContain("file_read");
    }
  });

  it("allows a non-write tool that is in the list", () => {
    const a = agent({ tools: ["file_read", "file_list"] });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_read",
      tool_args: { path: "anywhere/at/all.ts" },
    });
    expect(r.allowed).toBe(true);
  });
});

describe("gateToolCall — write_scope", () => {
  it("rejects a write outside the scope", () => {
    const a = agent({
      tools: ["file_write"],
      write_scope: ["**/*.test.ts", "**/__tests__/**"],
    });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: { path: "src/index.ts" },
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe("write_outside_scope");
      expect(r.attempted_path).toBe("src/index.ts");
      expect(r.scope).toEqual(["**/*.test.ts", "**/__tests__/**"]);
    }
  });

  it("allows a write inside the scope (matches **/*.test.ts)", () => {
    const a = agent({
      tools: ["file_write"],
      write_scope: ["**/*.test.ts", "**/__tests__/**"],
    });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: { path: "src/utils/foo.test.ts" },
    });
    expect(r.allowed).toBe(true);
  });

  it("allows a write inside the scope (matches **/__tests__/**)", () => {
    const a = agent({
      tools: ["file_write"],
      write_scope: ["**/*.test.ts", "**/__tests__/**"],
    });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: { path: "src/foo/__tests__/bar.ts" },
    });
    expect(r.allowed).toBe(true);
  });

  it("treats no write_scope as broad allow (default for write-capable agents)", () => {
    const a = agent({
      tools: ["file_write"],
      // write_scope intentionally absent
    });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: { path: "anywhere/at/all.ts" },
    });
    expect(r.allowed).toBe(true);
  });

  it("treats empty write_scope as broad allow", () => {
    const a = agent({ tools: ["file_write"], write_scope: [] });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: { path: "anywhere/at/all.ts" },
    });
    expect(r.allowed).toBe(true);
  });

  it("scope check applies to file_edit too", () => {
    const a = agent({
      tools: ["file_edit"],
      write_scope: ["**/*.test.ts"],
    });
    const denied = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_edit",
      tool_args: { path: "src/foo.ts" },
    });
    expect(denied.allowed).toBe(false);
    const allowed = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_edit",
      tool_args: { path: "src/foo.test.ts" },
    });
    expect(allowed.allowed).toBe(true);
  });

  it("non-write tools are unaffected by write_scope", () => {
    const a = agent({
      tools: ["file_read", "file_write"],
      write_scope: ["**/*.test.ts"],
    });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_read",
      tool_args: { path: "src/index.ts" },
    });
    expect(r.allowed).toBe(true);
  });

  it("missing path argument on a write call passes the gate (executor will error)", () => {
    const a = agent({
      tools: ["file_write"],
      write_scope: ["**/*.test.ts"],
    });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: {},
    });
    expect(r.allowed).toBe(true);
  });

  it("falls back to file/filename keys when path is absent", () => {
    const a = agent({
      tools: ["file_write"],
      write_scope: ["**/*.test.ts"],
    });
    const r = gateToolCall({
      agent_id: a.id,
      agent_def: a,
      tool_name: "file_write",
      tool_args: { file: "src/index.ts" },
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.attempted_path).toBe("src/index.ts");
  });
});

describe("formatDenialForLLM", () => {
  it("renders a tool_not_in_allowlist denial as a recoverable hint", () => {
    const denial = gateToolCall({
      agent_id: "reviewer",
      agent_def: agent({ id: "reviewer", tools: ["file_read"] }),
      tool_name: "file_write",
      tool_args: { path: "src/x.ts" },
    });
    if (denial.allowed) throw new Error("expected denial");
    const text = formatDenialForLLM(denial);
    expect(text).toContain("[BLOCKED by capability gate]");
    expect(text).toContain("reason: tool_not_in_allowlist");
    expect(text).toContain("Pick a different action");
  });

  it("renders a write_outside_scope denial with attempted_path and scope", () => {
    const denial = gateToolCall({
      agent_id: "tester",
      agent_def: agent({
        id: "tester",
        tools: ["file_write"],
        write_scope: ["**/*.test.ts"],
      }),
      tool_name: "file_write",
      tool_args: { path: "src/foo.ts" },
    });
    if (denial.allowed) throw new Error("expected denial");
    const text = formatDenialForLLM(denial);
    expect(text).toContain("attempted_path: src/foo.ts");
    expect(text).toContain("scope: [**/*.test.ts]");
  });
});
