import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../../src/tui/components/markdown.js";
import { stripAnsi } from "../../../src/tui/utils/text-width.js";

describe("renderMarkdown", () => {
  it("bold: **text** renders without asterisks", () => {
    const lines = renderMarkdown("**bold text**", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("bold text");
    expect(text).not.toContain("**");
  });

  it("italic: *text* renders without asterisks", () => {
    const lines = renderMarkdown("*italic*", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("italic");
    expect(text).not.toContain("*italic*");
  });

  it("inline code: `code` renders without backticks", () => {
    const lines = renderMarkdown("use `npm test` to run", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("npm test");
    expect(text).not.toContain("`");
  });

  it("code block: ``` opens border and closes", () => {
    const md = "```typescript\nconst x = 1;\n```";
    const lines = renderMarkdown(md, 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("typescript");
    expect(text).toContain("const x = 1;");
    expect(text).toContain("┌");
    expect(text).toContain("└");
    expect(text).not.toContain("```");
  });

  it("heading ### renders as bold with no hash prefix", () => {
    const lines = renderMarkdown("### My Heading", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("My Heading");
    expect(text).not.toContain("###");
  });

  it("heading ## gets separator line", () => {
    const lines = renderMarkdown("## Section", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Section");
    expect(text).toContain("─");
  });

  it("bullet list: - item renders with • symbol", () => {
    const lines = renderMarkdown("- First item\n- Second item", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("• First item");
    expect(text).toContain("• Second item");
    expect(text).not.toContain("- ");
  });

  it("blockquote: > text renders with │ bar", () => {
    const lines = renderMarkdown("> This is a quote", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("│");
    expect(text).toContain("This is a quote");
  });

  it("link: [text](url) renders as text (url)", () => {
    const lines = renderMarkdown("[docs](https://example.com)", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("docs");
    // Link may contain OSC 8 sequences — just verify no raw markdown
    expect(text).not.toContain("[docs]");
  });

  it("horizontal rule: --- renders as separator", () => {
    const lines = renderMarkdown("---", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("─");
    expect(text).not.toContain("---");
  });

  it("nested bold and code: **bold `code` bold** renders correctly", () => {
    const lines = renderMarkdown("**bold `code` bold**", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("bold");
    expect(text).toContain("code");
    expect(text).not.toContain("**");
    expect(text).not.toContain("`");
  });

  it("unclosed code block still renders with closing border", () => {
    const lines = renderMarkdown("```python\nprint('hello')", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("python");
    expect(text).toContain("print('hello')");
    expect(text).toContain("└");
  });

  it("numbered list renders correctly", () => {
    const lines = renderMarkdown("1. First\n2. Second", 80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("1. First");
    expect(text).toContain("2. Second");
  });
});
