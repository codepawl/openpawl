import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

interface LogFileInfo {
  path: string;
  mtimeMs: number;
}

export interface SessionLogRotationOptions {
  logDir: string;
  prefix: string;
  maxFiles?: number;
}

export async function rotateAndCreateSessionLog(
  options: SessionLogRotationOptions,
): Promise<string> {
  const maxFiles = options.maxFiles ?? 10;
  await mkdir(options.logDir, { recursive: true });

  const entries = await readdir(options.logDir, { withFileTypes: true });
  const prefix = `${options.prefix}-`;
  const logFiles: LogFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".log")) continue;
    if (!entry.name.startsWith(prefix)) continue;

    const fullPath = path.join(options.logDir, entry.name);
    try {
      const info = await stat(fullPath);
      logFiles.push({ path: fullPath, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore stat errors and continue rotating known files.
    }
  }

  logFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
  while (logFiles.length >= maxFiles) {
    const oldest = logFiles.shift();
    if (!oldest) break;
    await unlink(oldest.path).catch(() => {});
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(options.logDir, `${options.prefix}-${timestamp}.log`);
  await writeFile(logPath, "", "utf-8");
  return logPath;
}
