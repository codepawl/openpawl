/**
 * Tests for TUI components — all use VirtualTerminal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextComponent } from "../../../src/tui/components/text.js";
import { DividerComponent } from "../../../src/tui/components/divider.js";
import { SpinnerComponent } from "../../../src/tui/components/spinner.js";
import { StatusBarComponent } from "../../../src/tui/components/status-bar.js";
import { SelectListComponent, type SelectItem } from "../../../src/tui/components/select-list.js";
import { MessagesComponent, type ChatMessage } from "../../../src/tui/components/messages.js";
import { EditorComponent } from "../../../src/tui/components/editor.js";
import { OverlayComponent } from "../../../src/tui/components/overlay.js";
import { MarkdownComponent, renderMarkdown } from "../../../src/tui/components/markdown.js";
import { stripAnsi } from "../../../src/tui/utils/text-width.js";

describe("TextComponent", () => {
  it("renders content as lines", () => {
    const text = new TextComponent("t1", "Hello World");
    const lines = text.render(80);
    expect(lines).toEqual(["Hello World"]);
  });

  it("wraps long text to width", () => {
    const text = new TextComponent("t1", "Hello World this is a long line");
    const lines = text.render(15);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("returns empty array for empty content", () => {
    const text = new TextComponent("t1", "");
    expect(text.render(80)).toEqual([]);
  });

  it("setContent updates the text", () => {
    const text = new TextComponent("t1", "original");
    text.setContent("updated");
    expect(text.render(80)).toEqual(["updated"]);
  });
});

describe("DividerComponent", () => {
  it("renders a line of the given width", () => {
    const div = new DividerComponent("d1");
    const lines = div.render(40);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toHaveLength(40);
  });

  it("uses custom character", () => {
    const div = new DividerComponent("d1", "=");
    const lines = div.render(10);
    expect(stripAnsi(lines[0]!)).toBe("==========");
  });
});

describe("SpinnerComponent", () => {
  it("renders spinner frame with message", () => {
    const spinner = new SpinnerComponent("s1", "Loading...");
    const lines = spinner.render(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Loading...");
  });

  it("starts and stops animation", () => {
    const spinner = new SpinnerComponent("s1", "test");
    const renderFn = vi.fn();
    spinner.setRenderCallback(renderFn);

    spinner.start();
    // Timer should be set (won't assert on timing — just that it stops cleanly)
    spinner.stop();
    expect(() => spinner.stop()).not.toThrow(); // double stop is safe
  });

  it("updates message", () => {
    const spinner = new SpinnerComponent("s1", "old");
    spinner.setMessage("new");
    const lines = spinner.render(80);
    expect(lines[0]).toContain("new");
  });
});

describe("StatusBarComponent", () => {
  it("renders left and right items", () => {
    const bar = new StatusBarComponent("bar1");
    bar.setLeft("Model: claude-sonnet");
    bar.setRight("$0.42");
    const lines = bar.render(60);
    expect(lines).toHaveLength(1);
    const text = stripAnsi(lines[0]!);
    expect(text).toContain("Model: claude-sonnet");
    expect(text).toContain("$0.42");
  });

  it("pads to full width", () => {
    const bar = new StatusBarComponent("bar1", (s) => s); // no styling
    bar.setLeft("Left");
    bar.setRight("Right");
    const lines = bar.render(40);
    expect(lines[0]).toHaveLength(40);
  });
});

describe("SelectListComponent", () => {
  const items: SelectItem[] = [
    { label: "Alpha", value: "a" },
    { label: "Beta", value: "b", description: "Second item" },
    { label: "Gamma", value: "c" },
  ];

  it("renders all items", () => {
    const list = new SelectListComponent("sel1");
    list.setItems(items);
    const lines = list.render(80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).toContain("Gamma");
  });

  it("navigates with arrow keys", () => {
    const list = new SelectListComponent("sel1");
    list.setItems(items);
    expect(list.getSelectedItem()?.value).toBe("a");

    list.onKey({ type: "arrow", direction: "down", ctrl: false, alt: false });
    expect(list.getSelectedItem()?.value).toBe("b");

    list.onKey({ type: "arrow", direction: "up", ctrl: false, alt: false });
    expect(list.getSelectedItem()?.value).toBe("a");
  });

  it("fires onSelect on Enter", () => {
    const onSelect = vi.fn();
    const list = new SelectListComponent("sel1");
    list.setItems(items);
    list.onSelect = onSelect;

    list.onKey({ type: "enter" });
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it("fires onCancel on Escape", () => {
    const onCancel = vi.fn();
    const list = new SelectListComponent("sel1");
    list.setItems(items);
    list.onCancel = onCancel;

    list.onKey({ type: "escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("filters items", () => {
    const list = new SelectListComponent("sel1");
    list.setItems(items);
    list.setFilter("bet");
    const lines = list.render(80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("Beta");
    expect(text).not.toContain("Alpha");
    expect(text).not.toContain("Gamma");
  });

  it("shows 'no matching items' when filter matches nothing", () => {
    const list = new SelectListComponent("sel1");
    list.setItems(items);
    list.setFilter("xyz");
    const lines = list.render(80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text.toLowerCase()).toContain("no matching");
  });
});

describe("MessagesComponent", () => {
  it("renders messages", () => {
    const msgs = new MessagesComponent("msgs1");
    msgs.addMessage({ role: "user", content: "Hello" });
    msgs.addMessage({ role: "assistant", content: "Hi there!" });
    const lines = msgs.render(80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("Hello");
    expect(text).toContain("Hi there!");
  });

  it("supports streaming append", () => {
    const msgs = new MessagesComponent("msgs1");
    msgs.addMessage({ role: "assistant", content: "" });
    msgs.appendToLast("Hello");
    msgs.appendToLast(" World");
    const lines = msgs.render(80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("Hello World");
  });

  it("clears all messages", () => {
    const msgs = new MessagesComponent("msgs1");
    msgs.addMessage({ role: "user", content: "test" });
    msgs.clear();
    expect(msgs.getMessageCount()).toBe(0);
  });

  it("renders all lines without internal scroll (TUI manages viewport)", () => {
    const msgs = new MessagesComponent("msgs1");
    for (let i = 0; i < 20; i++) {
      msgs.addMessage({ role: "user", content: `Message ${i}` });
    }
    const lines = msgs.render(80);
    // All 20 messages rendered (each has content line + empty separator)
    expect(lines.length).toBeGreaterThanOrEqual(20);
  });
});

describe("EditorComponent", () => {
  it("accepts typed characters", () => {
    const editor = new EditorComponent("ed1");
    editor.onKey({ type: "char", char: "H", ctrl: false, alt: false, shift: true });
    editor.onKey({ type: "char", char: "i", ctrl: false, alt: false, shift: false });
    expect(editor.getText()).toBe("Hi");
  });

  it("handles backspace", () => {
    const editor = new EditorComponent("ed1");
    editor.onKey({ type: "char", char: "a", ctrl: false, alt: false, shift: false });
    editor.onKey({ type: "char", char: "b", ctrl: false, alt: false, shift: false });
    editor.onKey({ type: "backspace" });
    expect(editor.getText()).toBe("a");
  });

  it("fires onSubmit on Enter with content", () => {
    const onSubmit = vi.fn();
    const editor = new EditorComponent("ed1");
    editor.onSubmit = onSubmit;
    editor.onKey({ type: "char", char: "h", ctrl: false, alt: false, shift: false });
    editor.onKey({ type: "char", char: "i", ctrl: false, alt: false, shift: false });
    editor.onKey({ type: "enter" });
    expect(onSubmit).toHaveBeenCalledWith("hi", undefined);
    expect(editor.getText()).toBe(""); // cleared after submit
  });

  it("does not submit empty input", () => {
    const onSubmit = vi.fn();
    const editor = new EditorComponent("ed1");
    editor.onSubmit = onSubmit;
    editor.onKey({ type: "enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("navigates history with up/down arrows", () => {
    const editor = new EditorComponent("ed1");
    editor.pushHistory("first command");
    editor.pushHistory("second command");

    // Up → shows "second command"
    editor.onKey({ type: "arrow", direction: "up", ctrl: false, alt: false });
    expect(editor.getText()).toBe("second command");

    // Up again → shows "first command"
    editor.onKey({ type: "arrow", direction: "up", ctrl: false, alt: false });
    expect(editor.getText()).toBe("first command");

    // Down → back to "second command"
    editor.onKey({ type: "arrow", direction: "down", ctrl: false, alt: false });
    expect(editor.getText()).toBe("second command");

    // Down → back to empty
    editor.onKey({ type: "arrow", direction: "down", ctrl: false, alt: false });
    expect(editor.getText()).toBe("");
  });

  it("handles paste events", () => {
    const editor = new EditorComponent("ed1");
    editor.onKey({ type: "paste", text: "pasted text" });
    expect(editor.getText()).toBe("pasted text");
  });

  it("Ctrl+U clears current line", () => {
    const editor = new EditorComponent("ed1");
    editor.setText("some text");
    editor.onKey({ type: "char", char: "u", ctrl: true, alt: false, shift: false });
    expect(editor.getText()).toBe("");
  });

  it("renders with border", () => {
    const editor = new EditorComponent("ed1");
    const lines = editor.render(40);
    expect(lines.length).toBeGreaterThanOrEqual(3); // top border + content + bottom border
    expect(stripAnsi(lines[0]!)).toContain("┌");
    expect(stripAnsi(lines[lines.length - 1]!)).toContain("└");
  });
});

describe("OverlayComponent", () => {
  it("wraps child in a box", () => {
    const child = new TextComponent("inner", "Modal content");
    const overlay = new OverlayComponent("overlay1", child, 30);
    const lines = overlay.render(80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("Modal content");
    expect(text).toContain("┌");
    expect(text).toContain("└");
  });

  it("routes input to child", () => {
    const onKey = vi.fn().mockReturnValue(true);
    const child = { id: "inner", render: () => ["test"], onKey };
    const overlay = new OverlayComponent("overlay1", child, 30);
    const handled = overlay.onKey({ type: "enter" });
    expect(handled).toBe(true);
    expect(onKey).toHaveBeenCalled();
  });
});

describe("MarkdownComponent", () => {
  it("renders headers with styling", () => {
    const lines = renderMarkdown("# Title\n\nBody text", 80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("Title");
    expect(text).toContain("Body text");
  });

  it("renders code blocks", () => {
    const lines = renderMarkdown("```js\nconsole.log('hi');\n```", 80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("console.log");
    expect(text).toContain("js"); // language label
  });

  it("renders bullet lists", () => {
    const lines = renderMarkdown("- Item 1\n- Item 2\n- Item 3", 80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("•");
    expect(text).toContain("Item 1");
    expect(text).toContain("Item 3");
  });

  it("renders blockquotes", () => {
    const lines = renderMarkdown("> This is a quote", 80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("│");
    expect(text).toContain("This is a quote");
  });

  it("renders horizontal rules", () => {
    const lines = renderMarkdown("---", 80);
    const text = lines.map(l => stripAnsi(l)).join("\n");
    expect(text).toContain("─");
  });

  it("handles inline bold and italic", () => {
    const lines = renderMarkdown("This is **bold** and *italic*", 80);
    const raw = lines.join("");
    // Bold uses \x1b[1m
    expect(raw).toContain("\x1b[1m");
    // Italic uses \x1b[3m
    expect(raw).toContain("\x1b[3m");
  });
});
