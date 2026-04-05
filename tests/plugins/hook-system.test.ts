import { describe, it, expect, vi } from "vitest";
import { HookSystem } from "../../src/plugins/hook-system.js";
import type { PluginDefinition, PluginContext } from "../../src/plugins/types.js";

function makeCtx(): PluginContext {
  return { config: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, emit: vi.fn() };
}

function makePlugin(name: string, hooks: PluginDefinition["hooks"] = {}): PluginDefinition {
  return { name, version: "1.0.0", description: name, hooks };
}

describe("HookSystem", () => {
  it("executeHook calls all registered hooks in order", async () => {
    const system = new HookSystem();
    const order: string[] = [];

    system.register(makePlugin("b-plugin", { onStartup: async () => { order.push("b"); } }), makeCtx());
    system.register(makePlugin("a-plugin", { onStartup: async () => { order.push("a"); } }), makeCtx());

    await system.executeHook("onStartup");
    expect(order).toEqual(["a", "b"]); // Alphabetical
  });

  it("hook error in one plugin doesn't block others", async () => {
    const system = new HookSystem();
    const called: string[] = [];

    system.register(makePlugin("a", { onStartup: async () => { throw new Error("fail"); } }), makeCtx());
    system.register(makePlugin("b", { onStartup: async () => { called.push("b"); } }), makeCtx());

    await system.executeHook("onStartup");
    expect(called).toContain("b");
  });

  it("onPromptReceived chains transformations", async () => {
    const system = new HookSystem();

    system.register(makePlugin("upper", {
      onPromptReceived: async (_ctx, prompt) => (prompt as string).toUpperCase(),
    }), makeCtx());
    system.register(makePlugin("prefix", {
      onPromptReceived: async (_ctx, prompt) => `PRE: ${prompt}`,
    }), makeCtx());

    // Alphabetical: prefix runs first, then upper
    const result = await system.executePromptPipeline("hello");
    expect(result).toBe("PRE: HELLO");
  });

  it("unregister removes plugin", async () => {
    const system = new HookSystem();
    const called: string[] = [];

    system.register(makePlugin("a", { onStartup: async () => { called.push("a"); } }), makeCtx());
    system.unregister("a");

    await system.executeHook("onStartup");
    expect(called).toHaveLength(0);
  });

  it("getRegistered returns all plugins", () => {
    const system = new HookSystem();
    system.register(makePlugin("x"), makeCtx());
    system.register(makePlugin("y"), makeCtx());
    expect(system.getRegistered()).toHaveLength(2);
  });
});
