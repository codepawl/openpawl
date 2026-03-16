/**
 * Loads custom agent definitions from .ts/.js files, directories, or npm packages.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { validateAgentDefinition } from "./validator.js";
import type { ValidatedAgentDef } from "./validator.js";

/** Compile a .ts file to a temp .mjs using esbuild's transform API. */
async function compileTs(filePath: string): Promise<string> {
  // esbuild is a transitive dep via tsup — dynamic import to avoid hard dependency
  const esbuildModule = "esbuild";
  const esbuild = await import(/* webpackIgnore: true */ esbuildModule) as { transform: (code: string, opts: Record<string, unknown>) => Promise<{ code: string }> };
  const source = await readFile(filePath, "utf-8");
  const result = await esbuild.transform(source, {
    loader: "ts",
    format: "esm",
    target: "node20",
  });
  const tmpDir = path.join(os.tmpdir(), "teamclaw-agent-compile");
  await mkdir(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, `${path.basename(filePath, path.extname(filePath))}-${Date.now()}.mjs`);
  await writeFile(outFile, result.code, "utf-8");
  return outFile;
}

/** Import a module and extract agent definition(s). */
async function importAgentModule(modulePath: string): Promise<ValidatedAgentDef[]> {
  const fileUrl = pathToFileURL(modulePath).href;
  const mod = await import(fileUrl);
  const defs: ValidatedAgentDef[] = [];

  // Support: export default defineAgent({...})
  if (mod.default) {
    const defaultExport = mod.default;
    if (Array.isArray(defaultExport)) {
      for (const item of defaultExport) {
        const result = validateAgentDefinition(item);
        if (result.success && result.data) defs.push(result.data);
        else throw new Error(`Invalid agent in array: ${result.errors?.join("; ")}`);
      }
    } else {
      const result = validateAgentDefinition(defaultExport);
      if (result.success && result.data) defs.push(result.data);
      else throw new Error(`Invalid default export: ${result.errors?.join("; ")}`);
    }
    return defs;
  }

  // Support: export const agents = [...]
  if (mod.agents && Array.isArray(mod.agents)) {
    for (const item of mod.agents) {
      const result = validateAgentDefinition(item);
      if (result.success && result.data) defs.push(result.data);
      else throw new Error(`Invalid agent in agents array: ${result.errors?.join("; ")}`);
    }
    return defs;
  }

  // Support: export const agent = defineAgent({...})
  if (mod.agent) {
    const result = validateAgentDefinition(mod.agent);
    if (result.success && result.data) defs.push(result.data);
    else throw new Error(`Invalid agent export: ${result.errors?.join("; ")}`);
    return defs;
  }

  throw new Error("No agent definition found. Export a default, or named 'agent'/'agents'.");
}

/** Load agent definition(s) from a single .ts or .js file. */
export async function loadAgentFromFile(filePath: string): Promise<ValidatedAgentDef[]> {
  const absPath = path.resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".ts") {
    const compiled = await compileTs(absPath);
    return importAgentModule(compiled);
  }
  if (ext === ".js" || ext === ".mjs") {
    return importAgentModule(absPath);
  }
  throw new Error(`Unsupported file type: ${ext}. Use .ts, .js, or .mjs.`);
}

/** Load all agent definitions from a directory. */
export async function loadAgentsFromDirectory(dirPath: string): Promise<ValidatedAgentDef[]> {
  const absDir = path.resolve(dirPath);
  if (!existsSync(absDir)) {
    throw new Error(`Directory not found: ${absDir}`);
  }

  const files = readdirSync(absDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ext === ".ts" || ext === ".js" || ext === ".mjs";
  });

  const all: ValidatedAgentDef[] = [];
  for (const file of files) {
    const defs = await loadAgentFromFile(path.join(absDir, file));
    all.push(...defs);
  }
  return all;
}

/** Load an agent from an npm package name. */
export async function loadAgentFromNpm(packageName: string): Promise<ValidatedAgentDef[]> {
  const agentDir = path.join(os.homedir(), ".teamclaw", "agents");
  await mkdir(agentDir, { recursive: true });

  // Install the package into the agent directory
  const { execFileSync } = await import("node:child_process");
  execFileSync("npm", ["install", "--prefix", agentDir, packageName], {
    stdio: "pipe",
    timeout: 60_000,
  });

  // Import the installed package
  const modulePath = path.join(agentDir, "node_modules", packageName);
  return importAgentModule(modulePath);
}
