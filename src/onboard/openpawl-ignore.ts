/**
 * .openpawlignore — files/dirs agents should NOT access.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_PATTERNS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".env",
  ".env.*",
  "*.key",
  "*.pem",
  "*.p12",
  "__pycache__/",
  ".openpawl/",
  "*.lock",
];

export class OpenpawlIgnore {
  private patterns: string[] = [];
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async load(): Promise<void> {
    this.patterns = [...DEFAULT_PATTERNS];

    const ignorePath = path.join(this.projectRoot, ".openpawlignore");
    if (existsSync(ignorePath)) {
      try {
        const content = await readFile(ignorePath, "utf-8");
        const userPatterns = content
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"));
        this.patterns.push(...userPatterns);
      } catch {
        // File unreadable — use defaults only
      }
    }
  }

  isIgnored(filePath: string): boolean {
    const relative = path.relative(this.projectRoot, path.resolve(this.projectRoot, filePath));

    for (const pattern of this.patterns) {
      // Directory pattern (ends with /)
      if (pattern.endsWith("/")) {
        const dir = pattern.slice(0, -1);
        if (relative.startsWith(dir) || relative.includes(`/${dir}`)) return true;
      }
      // Glob pattern (contains *)
      else if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        if (regex.test(relative) || regex.test(path.basename(relative))) return true;
      }
      // Exact match
      else {
        if (relative === pattern || relative.startsWith(pattern + "/") || path.basename(relative) === pattern) return true;
      }
    }

    return false;
  }

  getPatterns(): string[] {
    return [...this.patterns];
  }
}
