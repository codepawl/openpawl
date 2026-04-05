/**
 * Markdown renderer — converts markdown text to ANSI-styled terminal lines.
 * Supports a useful subset: headers, bold, italic, inline code, code blocks,
 * bullet lists, blockquotes, links, and horizontal rules.
 */
import type { Component } from "../core/component.js";
import { bold, italic } from "../core/ansi.js";
import { wrapText } from "../utils/wrap.js";
import { defaultTheme, ctp } from "../themes/default.js";

export class MarkdownComponent implements Component {
  readonly id: string;
  private content: string;

  constructor(id: string, content = "") {
    this.id = id;
    this.content = content;
  }

  render(width: number): string[] {
    return renderMarkdown(this.content, width);
  }

  setContent(content: string): void {
    this.content = content;
  }
}

/** Render markdown string to ANSI-styled lines. */
export function renderMarkdown(md: string, width: number): string[] {
  const lines = md.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        const label = codeBlockLang || "code";
        result.push(ctp.surface1("┌─ ") + ctp.overlay1(label) + " " + ctp.surface1("─".repeat(Math.max(0, width - 5 - label.length))));
      } else {
        inCodeBlock = false;
        codeBlockLang = "";
        result.push(ctp.surface1("└" + "─".repeat(width - 1)));
      }
      continue;
    }

    // Inside code block — no inline processing, render with border
    if (inCodeBlock) {
      result.push(ctp.surface1("│ ") + ctp.text(line));
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      result.push(ctp.surface1("─".repeat(width)));
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      const text = headerMatch[2]!;
      const styled = level <= 2
        ? defaultTheme.markdown.heading(text)
        : bold(text);
      result.push("");
      result.push(styled);
      if (level === 1) result.push(ctp.surface1("═".repeat(Math.min(width, text.length + 4))));
      else if (level === 2) result.push(ctp.surface1("─".repeat(Math.min(width, text.length + 4))));
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const content = line.slice(2);
      result.push(defaultTheme.markdown.blockquote(processInline(content)));
      continue;
    }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (bulletMatch) {
      const indent = bulletMatch[1]!;
      const text = bulletMatch[2]!;
      const wrapped = wrapText(processInline(text), width - indent.length - 2);
      wrapped.forEach((wl, i) => {
        const prefix = i === 0 ? indent + ctp.blue("• ") : indent + "  ";
        result.push(prefix + wl);
      });
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (numMatch) {
      const indent = numMatch[1]!;
      const text = numMatch[2]!;
      const wrapped = wrapText(processInline(text), width - indent.length - 3);
      wrapped.forEach((wl, i) => {
        const prefix = i === 0 ? indent + line.match(/\d+/)![0] + ". " : indent + "   ";
        result.push(prefix + wl);
      });
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      result.push("");
      continue;
    }

    // Regular paragraph — process inline styles and wrap
    const processed = processInline(line);
    result.push(...wrapText(processed, width));
  }

  // Close unclosed code block
  if (inCodeBlock) {
    result.push(ctp.surface1("└" + "─".repeat(width - 1)));
  }

  return result;
}

/** Process inline markdown: bold, italic, code, links. */
function processInline(text: string): string {
  let result = text;

  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    return defaultTheme.markdown.code(` ${code} `);
  });

  // Bold+italic: ***text***
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, (_match, t: string) => bold(italic(t)));

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, t: string) => bold(t));

  // Italic: *text*
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_match, t: string) => italic(t));

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, (_match, t: string) => `\x1b[9m${t}\x1b[29m`);

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => {
    return `\x1b]8;;${url}\x1b\\${defaultTheme.markdown.link(text)}\x1b]8;;\x1b\\`;
  });

  return result;
}
