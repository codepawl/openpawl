import { describe, it, expect } from "bun:test";
import { ToolCallTokenFilter } from "../../../src/tui/text/tool-call-filter.js";

/** Helper: feed a string char-by-char and collect output */
function filterCharByChar(input: string): string {
  let result = "";
  const filter = new ToolCallTokenFilter((text) => { result += text; });
  for (const ch of input) {
    filter.feed(ch);
  }
  filter.flush();
  return result;
}

/** Helper: feed entire string as one token and collect output */
function filterWhole(input: string): string {
  let result = "";
  const filter = new ToolCallTokenFilter((text) => { result += text; });
  filter.feed(input);
  filter.flush();
  return result;
}

describe("ToolCallTokenFilter", () => {
  describe("passthrough", () => {
    it("passes plain text through unchanged", () => {
      expect(filterCharByChar("Hello world")).toBe("Hello world");
    });

    it("passes multi-line text through", () => {
      const input = "Line 1\nLine 2\nLine 3";
      expect(filterCharByChar(input)).toBe(input);
    });

    it("passes inline backticks through", () => {
      expect(filterCharByChar("Use `code` here")).toBe("Use `code` here");
    });

    it("passes double backticks through", () => {
      expect(filterCharByChar("Use ``code`` here")).toBe("Use ``code`` here");
    });
  });

  describe("tool_call fence suppression", () => {
    it("suppresses a complete tool_call block", () => {
      const input = '```tool_call\n{"name": "web_search", "input": {"query": "test"}}\n```';
      expect(filterCharByChar(input)).toBe("");
    });

    it("suppresses tool_call with trailing whitespace in info string", () => {
      const input = '```tool_call  \n{"name": "web_search"}\n```';
      expect(filterCharByChar(input)).toBe("");
    });

    it("preserves text before and after tool_call block", () => {
      const input = 'Here is my plan.\n```tool_call\n{"name": "web_search", "input": {}}\n```\nContinuing...';
      expect(filterCharByChar(input)).toBe("Here is my plan.\n\nContinuing...");
    });

    it("suppresses multiple consecutive tool_call blocks", () => {
      const input = '```tool_call\n{"name": "a"}\n```\n```tool_call\n{"name": "b"}\n```';
      expect(filterCharByChar(input)).toBe("\n");
    });

    it("suppresses empty tool_call block", () => {
      const input = '```tool_call\n\n```';
      expect(filterCharByChar(input)).toBe("");
    });

    it("handles tool_call block split across multiple feed() calls", () => {
      let result = "";
      const filter = new ToolCallTokenFilter((t) => { result += t; });
      filter.feed("```");
      filter.feed("tool_call\n");
      filter.feed('{"name": "test"}\n');
      filter.feed("```");
      filter.flush();
      expect(result).toBe("");
    });
  });

  describe("regular code fence passthrough", () => {
    it("passes ```python blocks through", () => {
      const input = '```python\nprint("hello")\n```';
      expect(filterCharByChar(input)).toBe(input);
    });

    it("passes ```json blocks through", () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(filterCharByChar(input)).toBe(input);
    });

    it("passes ```typescript blocks through", () => {
      const input = '```typescript\nconst x = 1;\n```';
      expect(filterCharByChar(input)).toBe(input);
    });
  });

  describe("[TOOL_CALL] marker suppression", () => {
    it("suppresses [TOOL_CALL]...[/TOOL_CALL] block", () => {
      const input = '[TOOL_CALL]\n{"name": "web_search", "input": {"query": "test"}}\n[/TOOL_CALL]';
      expect(filterCharByChar(input)).toBe("");
    });

    it("preserves text around [TOOL_CALL] blocks", () => {
      const input = 'Before\n[TOOL_CALL]\n{"name": "a"}\n[/TOOL_CALL]\nAfter';
      expect(filterCharByChar(input)).toBe("Before\n\nAfter");
    });

    it("suppresses standalone [/TOOL_CALL] tag", () => {
      const input = "[/TOOL_CALL]";
      expect(filterCharByChar(input)).toBe("");
    });
  });

  describe("[Tool Result] marker suppression", () => {
    it("suppresses [Tool Result] marker", () => {
      const input = "[Tool Result]";
      expect(filterCharByChar(input)).toBe("");
    });

    it("suppresses [Tool Result (call_123_0)] marker", () => {
      const input = "[Tool Result (call_123_0)]";
      expect(filterCharByChar(input)).toBe("");
    });

    it("suppresses [Tool Result] with long call id", () => {
      const input = "[Tool Result (call_1712345678_42)]";
      expect(filterCharByChar(input)).toBe("");
    });
  });

  describe("maybe_marker buffer limit", () => {
    it("flushes buffer after 50 chars without match", () => {
      const input = "[Some user text that starts with a bracket and goes on for a very long time";
      expect(filterCharByChar(input)).toBe(input);
    });

    it("passes through [bracket text] that doesn't match markers", () => {
      const input = "[hello world]";
      expect(filterCharByChar(input)).toBe(input);
    });

    it("passes through [T but not Tool Result", () => {
      const input = "[The answer is 42]";
      expect(filterCharByChar(input)).toBe(input);
    });
  });

  describe("multi-character tokens", () => {
    it("handles tool_call block as a single token", () => {
      const input = '```tool_call\n{"name": "web_search"}\n```';
      expect(filterWhole(input)).toBe("");
    });

    it("handles mixed content as a single token", () => {
      const input = 'Text before ```tool_call\n{"name": "a"}\n``` text after';
      expect(filterWhole(input)).toBe("Text before  text after");
    });

    it("handles [TOOL_CALL] block as a single token", () => {
      const input = '[TOOL_CALL]\n{"name": "test"}\n[/TOOL_CALL]';
      expect(filterWhole(input)).toBe("");
    });
  });

  describe("flush behavior", () => {
    it("emits buffered non-tool content on flush", () => {
      let result = "";
      const filter = new ToolCallTokenFilter((t) => { result += t; });
      filter.feed("``");  // 2 backticks — waiting for 3rd
      filter.flush();
      expect(result).toBe("``");
    });

    it("discards suppressed content on flush (unclosed tool_call)", () => {
      let result = "";
      const filter = new ToolCallTokenFilter((t) => { result += t; });
      filter.feed('```tool_call\n{"name": "test"}');
      // No closing ``` — flush should discard
      filter.flush();
      expect(result).toBe("");
    });

    it("emits partial marker buffer on flush if not a match", () => {
      let result = "";
      const filter = new ToolCallTokenFilter((t) => { result += t; });
      filter.feed("[To");  // Partial — could be [Tool Result but incomplete
      filter.flush();
      expect(result).toBe("[To");
    });
  });

  describe("reset", () => {
    it("allows reuse after reset", () => {
      let result = "";
      const filter = new ToolCallTokenFilter((t) => { result += t; });

      filter.feed('```tool_call\n{"name": "a"}\n```');
      filter.flush();
      expect(result).toBe("");

      result = "";
      filter.reset();
      filter.feed("Hello");
      filter.flush();
      expect(result).toBe("Hello");
    });
  });

  describe("edge cases", () => {
    it("handles empty input", () => {
      expect(filterCharByChar("")).toBe("");
    });

    it("handles just backticks with no newline", () => {
      expect(filterCharByChar("```")).toBe("```");
    });

    it("handles interleaved text and multiple tool calls", () => {
      const input = [
        "Starting analysis...",
        '```tool_call\n{"name": "web_search", "input": {"query": "test1"}}\n```',
        "\nSearching further...",
        '```tool_call\n{"name": "web_fetch", "input": {"url": "http://example.com"}}\n```',
        "\nDone.",
      ].join("");

      expect(filterCharByChar(input)).toBe("Starting analysis...\nSearching further...\nDone.");
    });
  });

  describe("json fence tool call detection", () => {
    it("suppresses ```json block with tool call JSON", () => {
      const input = '```json\n{"name": "file_read", "input": {"path": "src/main.ts"}}\n```';
      expect(filterCharByChar(input)).toBe("");
    });

    it("suppresses ```json block with parameters key", () => {
      const input = '```json\n{"name": "shell_exec", "parameters": {"command": "ls"}}\n```';
      expect(filterCharByChar(input)).toBe("");
    });

    it("preserves ```json blocks that are NOT tool calls", () => {
      const input = '```json\n{"users": [1, 2, 3], "count": 3}\n```';
      const result = filterCharByChar(input);
      expect(result).toContain('"users"');
      expect(result).toContain("```");
    });

    it("preserves regular code fences (```typescript)", () => {
      const input = '```typescript\nconst x = 1;\n```';
      expect(filterCharByChar(input)).toBe(input);
    });

    it("handles text before and after json tool call", () => {
      const input = 'Here is my plan.\n```json\n{"name": "file_read", "input": {"path": "x.ts"}}\n```\nContinuing...';
      const result = filterCharByChar(input);
      expect(result).toContain("Here is my plan.");
      expect(result).toContain("Continuing...");
      expect(result).not.toContain("file_read");
    });

    it("handles whole-token feeding for json fence", () => {
      const input = '```json\n{"name": "web_search", "input": {"query": "test"}}\n```';
      expect(filterWhole(input)).toBe("");
    });
  });
});
