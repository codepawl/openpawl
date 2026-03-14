/**
 * File block parser — extracts file blocks from LLM output and writes them to disk.
 *
 * Matches patterns like:
 *   ```lang filename.ext       (fence header with filename)
 *   <!-- FILE: path/to/file -->  (XML-style marker before fence)
 *   **`filename.ext`**          (bold backtick filename before fence)
 *   // filename.ext             (comment-style filename before fence)
 *   `filename.ext`:             (backtick filename with colon before fence)
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileBlock {
  filename: string;
  content: string;
}

const FILE_EXT_RE = /\.[a-zA-Z0-9]{1,10}$/;

export function extractFileBlocks(output: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  // Match fenced code blocks, capturing the info string (after ```) and body
  const fenceRe = /(?:(?:<!-[-]\s*FILE:\s*(.+?)\s*-[-]->|[*]{2}`(.+?)`[*]{2}|\n`([^\n`]+?)`:\s*)\n)?```[^\S\n]*(\S+)?[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;

  while ((m = fenceRe.exec(output)) !== null) {
    // Priority: XML marker > bold backtick > backtick-colon > fence info-string
    const filename = (m[1] || m[2] || m[3] || "").trim();
    const fenceInfo = (m[4] || "").trim();
    const content = m[5] ?? "";

    let resolved = "";
    if (filename && FILE_EXT_RE.test(filename)) {
      resolved = filename;
    } else if (fenceInfo && FILE_EXT_RE.test(fenceInfo)) {
      // info string is sometimes "typescript src/app.ts" or just "app.ts"
      const parts = fenceInfo.split(/\s+/);
      const filePart = parts.find((p) => FILE_EXT_RE.test(p));
      if (filePart) resolved = filePart;
    }

    if (resolved) {
      // Normalize path: strip leading slashes, prevent traversal
      resolved = resolved.replace(/^\/+/, "").replace(/\.\.\//g, "");
      blocks.push({ filename: resolved, content });
    }
  }

  return blocks;
}

export async function writeFileBlocks(blocks: FileBlock[], workspaceDir: string): Promise<string[]> {
  const written: string[] = [];
  const wsAbs = path.resolve(process.cwd(), workspaceDir);

  for (const block of blocks) {
    const filePath = path.resolve(wsAbs, block.filename);
    // Safety: ensure resolved path is within workspace
    const rel = path.relative(wsAbs, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, block.content, "utf-8");
    written.push(block.filename);
  }
  return written;
}
