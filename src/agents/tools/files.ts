import { CONFIG } from "../../core/config.js";
import { listDir, readTextFile, writeTextFile } from "../../core/workspace-fs.js";

export async function readFileTool(filename: string): Promise<string> {
  return await readTextFile(filename, { workspaceDir: CONFIG.workspaceDir });
}

export async function writeFileTool(filename: string, content: string): Promise<void> {
  await writeTextFile(filename, content, { workspaceDir: CONFIG.workspaceDir, mkdirp: true });
}

export async function listDirTool(dir: string): Promise<string[]> {
  return await listDir(dir, { workspaceDir: CONFIG.workspaceDir });
}

