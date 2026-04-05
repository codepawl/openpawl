/**
 * Deep project analysis — framework, test runner, conventions, size.
 * All heuristic, no LLM calls. Must complete < 2s.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Result, ok, err } from "neverthrow";
import type { ProjectType, OnboardError } from "./types.js";

export interface ProjectAnalysis {
  type: ProjectType | null;
  name: string | null;
  framework?: string;
  language: string;
  testRunner?: string;
  linter?: string;
  packageManager: string;
  hasDocker: boolean;
  hasCI: boolean;
  hasDocs: boolean;
  hasTests: boolean;
  sourceDir: string;
  testDir: string;
  estimatedSize: "small" | "medium" | "large";
  conventions: ProjectConventions;
}

export interface ProjectConventions {
  indentation: "tabs" | "spaces-2" | "spaces-4" | "unknown";
  quotes: "single" | "double" | "unknown";
  fileNaming: "kebab" | "camel" | "pascal" | "snake" | "unknown";
}

export async function analyzeProject(cwd: string): Promise<Result<ProjectAnalysis, OnboardError>> {
  try {
    const [pkgJson, files] = await Promise.all([
      readJsonSafe(path.join(cwd, "package.json")),
      countFiles(cwd),
    ]);

    const type = detectProjectType(cwd);
    const language = detectLanguage(cwd, pkgJson);
    const framework = detectFramework(pkgJson);
    const testRunner = detectTestRunner(cwd, pkgJson);
    const linter = detectLinter(cwd, pkgJson);
    const packageManager = detectPM(cwd);

    return ok({
      type,
      name: typeof pkgJson?.name === "string" ? pkgJson.name : null,
      framework,
      language,
      testRunner,
      linter,
      packageManager,
      hasDocker: existsSync(path.join(cwd, "Dockerfile")) || existsSync(path.join(cwd, "docker-compose.yml")),
      hasCI: existsSync(path.join(cwd, ".github", "workflows")),
      hasDocs: existsSync(path.join(cwd, "docs")) || existsSync(path.join(cwd, "README.md")),
      hasTests: existsSync(path.join(cwd, "tests")) || existsSync(path.join(cwd, "__tests__")) || existsSync(path.join(cwd, "test")),
      sourceDir: existsSync(path.join(cwd, "src")) ? "src/" : ".",
      testDir: existsSync(path.join(cwd, "tests")) ? "tests/" : existsSync(path.join(cwd, "test")) ? "test/" : ".",
      estimatedSize: files < 50 ? "small" : files < 500 ? "medium" : "large",
      conventions: await detectConventions(cwd),
    });
  } catch (e) {
    return err({ type: "validation_failed" as const, cause: String(e) });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
  } catch { return null; }
}

function detectProjectType(cwd: string): ProjectType | null {
  if (existsSync(path.join(cwd, "package.json"))) return "node";
  if (existsSync(path.join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "requirements.txt"))) return "python";
  if (existsSync(path.join(cwd, "go.mod"))) return "go";
  if (existsSync(path.join(cwd, "Gemfile"))) return "ruby";
  if (existsSync(path.join(cwd, "pom.xml")) || existsSync(path.join(cwd, "build.gradle"))) return "java";
  return null;
}

function detectLanguage(cwd: string, pkg: Record<string, unknown> | null): string {
  if (existsSync(path.join(cwd, "tsconfig.json"))) return "typescript";
  if (pkg?.devDependencies && typeof pkg.devDependencies === "object" && "typescript" in (pkg.devDependencies as object)) return "typescript";
  if (existsSync(path.join(cwd, "package.json"))) return "javascript";
  if (existsSync(path.join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(path.join(cwd, "go.mod"))) return "go";
  if (existsSync(path.join(cwd, "pyproject.toml"))) return "python";
  return "unknown";
}

function detectFramework(pkg: Record<string, unknown> | null): string | undefined {
  if (!pkg) return undefined;
  const deps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) };
  if (deps.next) return "nextjs";
  if (deps.express) return "express";
  if (deps.fastify) return "fastify";
  if (deps.nestjs || deps["@nestjs/core"]) return "nestjs";
  if (deps.react && !deps.next) return "react";
  if (deps.vue) return "vue";
  if (deps.angular || deps["@angular/core"]) return "angular";
  if (deps.django) return "django";
  return undefined;
}

function detectTestRunner(cwd: string, pkg: Record<string, unknown> | null): string | undefined {
  if (!pkg) return undefined;
  const devDeps = pkg.devDependencies as Record<string, string> | undefined ?? {};
  if (devDeps.vitest || existsSync(path.join(cwd, "vitest.config.ts"))) return "vitest";
  if (devDeps.jest || existsSync(path.join(cwd, "jest.config.js"))) return "jest";
  if (existsSync(path.join(cwd, "pytest.ini")) || existsSync(path.join(cwd, "conftest.py"))) return "pytest";
  return undefined;
}

function detectLinter(cwd: string, pkg: Record<string, unknown> | null): string | undefined {
  if (existsSync(path.join(cwd, "biome.json"))) return "biome";
  if (existsSync(path.join(cwd, ".eslintrc.js")) || existsSync(path.join(cwd, "eslint.config.js"))) return "eslint";
  const devDeps = (pkg?.devDependencies ?? {}) as Record<string, string>;
  if (devDeps.eslint) return "eslint";
  if (devDeps.biome || devDeps["@biomejs/biome"]) return "biome";
  return undefined;
}

function detectPM(cwd: string): string {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

async function countFiles(cwd: string): Promise<number> {
  try {
    const entries = await readdir(cwd);
    // Quick estimate — count top-level + one level deep
    let count = entries.filter((e) => !e.startsWith(".") && e !== "node_modules").length;
    for (const entry of entries.slice(0, 5)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      try {
        const s = await stat(path.join(cwd, entry));
        if (s.isDirectory()) {
          const sub = await readdir(path.join(cwd, entry));
          count += sub.length;
        }
      } catch { /* skip */ }
    }
    return count;
  } catch { return 0; }
}

async function detectConventions(cwd: string): Promise<ProjectConventions> {
  const result: ProjectConventions = { indentation: "unknown", quotes: "unknown", fileNaming: "unknown" };

  // Sample up to 3 source files
  const srcDir = existsSync(path.join(cwd, "src")) ? path.join(cwd, "src") : cwd;
  try {
    const files = (await readdir(srcDir)).filter((f) => /\.(ts|js|py|rs)$/.test(f)).slice(0, 3);
    for (const file of files) {
      try {
        const content = await readFile(path.join(srcDir, file), "utf-8");
        const lines = content.split("\n").slice(0, 50);
        for (const line of lines) {
          if (line.startsWith("\t")) { result.indentation = "tabs"; break; }
          const spaces = line.match(/^( +)/);
          if (spaces) {
            result.indentation = spaces[1]!.length <= 2 ? "spaces-2" : "spaces-4";
            break;
          }
        }
        if (content.includes("'")) result.quotes = "single";
        else if (content.includes('"')) result.quotes = "double";
      } catch { /* skip */ }
    }

    // File naming convention
    const allFiles = files.map((f) => path.basename(f, path.extname(f)));
    if (allFiles.some((f) => f.includes("-"))) result.fileNaming = "kebab";
    else if (allFiles.some((f) => f.includes("_"))) result.fileNaming = "snake";
    else if (allFiles.some((f) => /^[A-Z]/.test(f))) result.fileNaming = "pascal";
    else if (allFiles.some((f) => /[a-z][A-Z]/.test(f))) result.fileNaming = "camel";
  } catch { /* skip */ }

  return result;
}
