import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "./sandbox.js";

export async function ensureWorkspaceDir(workspaceDir: string): Promise<void> {
  const abs = path.resolve(process.cwd(), workspaceDir);
  await mkdir(abs, { recursive: true });
}

export async function readTextFile(
  relPath: string,
  options: { workspaceDir: string }
): Promise<string> {
  const p = resolveSafePath(relPath, options.workspaceDir);
  return await readFile(p, "utf-8");
}

export async function writeTextFile(
  relPath: string,
  content: string,
  options: { workspaceDir: string; mkdirp?: boolean }
): Promise<void> {
  const p = resolveSafePath(relPath, options.workspaceDir);
  if (options.mkdirp) {
    await mkdir(path.dirname(p), { recursive: true });
  }
  await writeFile(p, content, "utf-8");
}

export async function listDir(
  relPath: string,
  options: { workspaceDir: string }
): Promise<string[]> {
  const p = resolveSafePath(relPath, options.workspaceDir);
  return await readdir(p);
}

