/**
 * @file reference resolver — reads files and returns content for TUI context.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_FILE_SIZE = 100 * 1024; // 100KB

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
  ".c": "c", ".cpp": "cpp", ".h": "c", ".cs": "csharp",
  ".rb": "ruby", ".php": "php", ".swift": "swift", ".kt": "kotlin",
  ".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".xml": "xml", ".html": "html", ".css": "css",
  ".sql": "sql", ".sh": "bash", ".zsh": "bash", ".fish": "fish",
  ".dockerfile": "dockerfile", ".graphql": "graphql",
};

export function resolveFileRef(
  filePath: string,
  cwd?: string,
): { path: string; content: string; language: string } | { error: string } {
  const resolved = path.resolve(cwd ?? process.cwd(), filePath);

  try {
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return { error: `"${filePath}" is a directory, not a file.` };
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { error: `"${filePath}" is too large (${(stat.size / 1024).toFixed(0)}KB, max ${MAX_FILE_SIZE / 1024}KB).` };
    }
  } catch {
    return { error: `File not found: "${filePath}"` };
  }

  try {
    const content = readFileSync(resolved, "utf-8");
    // Check for binary content (null bytes in first 512 chars)
    if (content.slice(0, 512).includes("\0")) {
      return { error: `"${filePath}" appears to be a binary file.` };
    }

    const ext = path.extname(resolved).toLowerCase();
    const language = EXT_TO_LANG[ext] ?? "";

    return { path: filePath, content, language };
  } catch (err) {
    return { error: `Failed to read "${filePath}": ${err instanceof Error ? err.message : String(err)}` };
  }
}
