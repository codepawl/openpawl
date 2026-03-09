/**
 * Line-preserving `.env` manager.
 *
 * Goals:
 * - Read/merge/write without deleting comments or unrelated variables.
 * - Update only the targeted key.
 * - Remove duplicates so the file has a single definitive value per key.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type EnvFile = {
  path: string;
  lines: string[];
};

function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function matchActiveAssignmentIndex(key: string, line: string): boolean {
  if (isCommentLine(line)) return false;
  // Allow leading whitespace; treat KEY= and KEY = as assignment.
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return re.test(line);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readEnvFile(cwd: string = process.cwd()): EnvFile {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) return { path: envPath, lines: [] };
  const raw = readFileSync(envPath, "utf-8");
  // Preserve line ordering; split without keeping newline characters.
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  // If the file ended with newline, split() adds a final empty string; keep it
  // so write back is stable.
  return { path: envPath, lines };
}

export function writeEnvFile(envPath: string, lines: string[]): void {
  // Ensure a single trailing newline for POSIX-friendly env files.
  const normalized = lines.join("\n").replace(/\n*$/, "\n");
  writeFileSync(envPath, normalized, "utf-8");
}

export function getEnvValue(key: string, lines: string[]): string | null {
  let found: string | null = null;
  for (const line of lines) {
    if (!matchActiveAssignmentIndex(key, line)) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    found = line.slice(idx + 1);
  }
  return found;
}

export function setEnvValue(key: string, value: string, lines: string[]): string[] {
  const v = value;
  const indices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matchActiveAssignmentIndex(key, lines[i] ?? "")) indices.push(i);
  }

  const next = [...lines];
  if (indices.length === 0) {
    // Append new key. Avoid creating a huge block of trailing empty lines.
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    next.push(`${key}=${v}`);
    return next;
  }

  // Update the last occurrence; remove earlier duplicates (keep comments intact).
  const lastIdx = indices[indices.length - 1]!;
  next[lastIdx] = `${key}=${v}`;
  for (let j = indices.length - 2; j >= 0; j--) {
    next.splice(indices[j]!, 1);
  }
  return next;
}

export function unsetEnvKey(key: string, lines: string[]): string[] {
  const next: string[] = [];
  for (const line of lines) {
    if (matchActiveAssignmentIndex(key, line)) continue;
    next.push(line);
  }
  return next;
}

