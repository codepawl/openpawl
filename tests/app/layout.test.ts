/**
 * Tests for TUI application layout.
 */
import { describe, it, expect } from "vitest";
import { createLayout } from "../../src/app/layout.js";
import { VirtualTerminal } from "../../src/tui/index.js";

describe("createLayout", () => {
  it("creates layout with all four components", () => {
    const term = new VirtualTerminal(80, 24);
    const layout = createLayout(term);

    expect(layout.tui).toBeDefined();
    expect(layout.statusBar).toBeDefined();
    expect(layout.messages).toBeDefined();
    expect(layout.editor).toBeDefined();
  });

  it("renders components to terminal", async () => {
    const term = new VirtualTerminal(80, 24);
    const layout = createLayout(term);
    layout.tui.start();

    await new Promise((r) => process.nextTick(r));

    const output = term.getRawOutput();
    // Status bar and editor placeholder should appear
    expect(output.length).toBeGreaterThan(0);

    layout.tui.stop();
  });

  it("editor has focus by default", () => {
    const term = new VirtualTerminal(80, 24);
    const layout = createLayout(term);
    expect(layout.tui.getFocus()).toBe(layout.editor);
  });

  it("messages component accepts messages", async () => {
    const term = new VirtualTerminal(80, 24);
    const layout = createLayout(term);
    layout.messages.addMessage({ role: "system", content: "Hello World" });
    layout.tui.start();

    await new Promise((r) => process.nextTick(r));

    const output = term.getRawOutput();
    expect(output).toContain("Hello");

    layout.tui.stop();
  });
});
