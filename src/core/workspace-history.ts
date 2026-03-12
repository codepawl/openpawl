/**
 * Workspace History — remembers recently used workspace directories.
 * Persists up to MAX_HISTORY entries in ~/.openclaw/teamclaw_history.json.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_HISTORY = 5;
const HISTORY_FILE = path.join(os.homedir(), ".openclaw", "teamclaw_history.json");

interface HistoryData {
    workspaces: string[];
}

function ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** Read the workspace history from disk. Returns an empty list on any error. */
export function readWorkspaceHistory(): string[] {
    try {
        const raw = fs.readFileSync(HISTORY_FILE, "utf8");
        const data = JSON.parse(raw) as HistoryData;
        if (Array.isArray(data.workspaces)) {
            return data.workspaces.filter((p) => typeof p === "string" && p.trim().length > 0);
        }
    } catch {
        // File missing or corrupt — start fresh
    }
    return [];
}

/**
 * Push a workspace path to the top of the history list.
 * Deduplicates and trims to MAX_HISTORY entries. Saves to disk.
 */
export function pushWorkspaceHistory(workspacePath: string): void {
    const absPath = path.resolve(workspacePath).trim();
    if (!absPath) return;

    try {
        const current = readWorkspaceHistory();
        // Remove existing occurrence (case-sensitive), then prepend
        const deduped = [absPath, ...current.filter((p) => p !== absPath)].slice(0, MAX_HISTORY);
        ensureDir(HISTORY_FILE);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify({ workspaces: deduped }, null, 2), "utf8");
    } catch {
        // Non-fatal: history save failures should never block work
    }
}
