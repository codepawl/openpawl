import { describe, it, expect, vi, beforeEach } from "bun:test";
import { getActiveProviderState, resetActiveProviderState } from "../../src/providers/active-state.js";

describe("ActiveProviderState", () => {
  beforeEach(() => {
    resetActiveProviderState();
  });

  it("default state is not configured", () => {
    const state = getActiveProviderState();
    expect(state.isConfigured()).toBe(false);
    expect(state.provider).toBe("");
    expect(state.model).toBe("");
  });

  it("setActive updates provider and model", () => {
    const state = getActiveProviderState();
    state.setActive("ollama", "llama3.1");
    expect(state.provider).toBe("ollama");
    expect(state.model).toBe("llama3.1");
    expect(state.connectionStatus).toBe("connected");
    expect(state.isConfigured()).toBe(true);
  });

  it("emits 'changed' event on setActive", () => {
    const state = getActiveProviderState();
    const handler = vi.fn();
    state.on("changed", handler);
    state.setActive("anthropic", "claude-sonnet-4");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: "anthropic",
      model: "claude-sonnet-4",
    }));
  });

  it("setModel updates only model", () => {
    const state = getActiveProviderState();
    state.setActive("ollama", "llama3.1");
    state.setModel("codellama:7b");
    expect(state.provider).toBe("ollama");
    expect(state.model).toBe("codellama:7b");
  });

  it("setDisconnected marks as disconnected", () => {
    const state = getActiveProviderState();
    state.setActive("ollama", "llama3.1");
    state.setDisconnected();
    expect(state.connectionStatus).toBe("disconnected");
    expect(state.isConfigured()).toBe(false);
  });

  it("autoDetected flag works", () => {
    const state = getActiveProviderState();
    state.setActive("ollama", "llama3.1", { autoDetected: true, endpoint: "localhost:11434" });
    expect(state.autoDetected).toBe(true);
    expect(state.endpoint).toBe("localhost:11434");
  });

  it("getState returns copy", () => {
    const state = getActiveProviderState();
    state.setActive("ollama", "llama3.1");
    const snapshot = state.getState();
    state.setModel("different");
    expect(snapshot.model).toBe("llama3.1"); // snapshot not mutated
  });
});
