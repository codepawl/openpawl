/**
 * Project context injection — reads CLAUDE.md or README.md from the
 * project root and detects basic project facts (language, framework).
 * Injected into the LLM system prompt so agents understand the codebase.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CONTEXT_CHARS = 4000;

let cachedContext: string | null = null;
let cachedDir: string | null = null;

/** Detect project type from config files in the given directory. */
function detectProjectType(dir: string): string[] {
  const facts: string[] = [];

  if (existsSync(join(dir, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      facts.push(`Node.js project: ${pkg.name ?? "unnamed"}`);
      if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript || existsSync(join(dir, "tsconfig.json"))) {
        facts.push("Language: TypeScript");
      } else {
        facts.push("Language: JavaScript");
      }
      if (pkg.dependencies?.react || pkg.devDependencies?.react) facts.push("Framework: React");
      if (pkg.dependencies?.next) facts.push("Framework: Next.js");
      if (pkg.dependencies?.fastify) facts.push("Framework: Fastify");
      if (pkg.dependencies?.express) facts.push("Framework: Express");
    } catch { /* ignore parse errors */ }
  } else if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "setup.py"))) {
    facts.push("Language: Python");
  } else if (existsSync(join(dir, "Cargo.toml"))) {
    facts.push("Language: Rust");
  } else if (existsSync(join(dir, "go.mod"))) {
    facts.push("Language: Go");
  }

  return facts;
}

/**
 * Build project context string for system prompt injection.
 * Reads CLAUDE.md first (more detailed), falls back to README.md.
 * Caches result per directory.
 */
export function getProjectContext(projectDir: string): string {
  if (cachedDir === projectDir && cachedContext !== null) {
    return cachedContext;
  }

  const parts: string[] = [];

  // Project type detection
  const facts = detectProjectType(projectDir);
  if (facts.length > 0) {
    parts.push("Project facts: " + facts.join(", "));
  }

  // Read CLAUDE.md or README.md for detailed context
  for (const file of ["CLAUDE.md", "README.md"]) {
    const filePath = join(projectDir, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const trimmed = content.slice(0, MAX_CONTEXT_CHARS);
        parts.push(`## Project Context (from ${file})\n\n${trimmed}`);
        break;
      } catch { /* ignore read errors */ }
    }
  }

  // Read workspace rules (.openpawl/rules.md)
  const rulesPath = join(projectDir, ".openpawl", "rules.md");
  if (existsSync(rulesPath)) {
    try {
      const rules = readFileSync(rulesPath, "utf-8").trim();
      // Skip if only the template comments remain
      const meaningful = rules.split("\n").filter((l) => !l.startsWith("#") && l.trim()).join("\n").trim();
      if (meaningful) {
        parts.push(`## Workspace Rules (from .openpawl/rules.md)\n\n${rules.slice(0, MAX_CONTEXT_CHARS)}`);
      }
    } catch { /* ignore read errors */ }
  }

  if (parts.length === 0) {
    cachedContext = "";
    cachedDir = projectDir;
    return "";
  }

  cachedContext = "\n\n" + parts.join("\n\n");
  cachedDir = projectDir;
  return cachedContext;
}

/** Clear the cache (useful for tests or when project changes). */
export function clearProjectContextCache(): void {
  cachedContext = null;
  cachedDir = null;
}
