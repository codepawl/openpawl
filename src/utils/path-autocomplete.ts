import { select, text, confirm, cancel, isCancel, note } from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface PathEntry {
    value: string;
    label: string;
    hint?: string;
}

/** List directories (and optionally files) at the given path. */
async function listDir(
    dirPath: string,
    opts?: { showFiles?: boolean },
): Promise<PathEntry[]> {
    const entries: PathEntry[] = [];
    try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        const sorted = items
            .filter((i) => !i.name.startsWith("."))
            .sort((a, b) => {
                // directories first, then alphabetical
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });

        for (const item of sorted) {
            if (item.name === "node_modules") continue;
            const fullPath = path.join(dirPath, item.name);
            if (item.isDirectory()) {
                entries.push({
                    value: fullPath,
                    label: `${pc.cyan(item.name)}/`,
                    hint: "dir",
                });
            } else if (opts?.showFiles) {
                entries.push({
                    value: fullPath,
                    label: pc.dim(item.name),
                    hint: "file",
                });
            }
        }
    } catch {
        // Permission error or path doesn't exist
    }
    return entries;
}

/** Shorten a path for display, replacing $HOME with ~. */
function displayPath(p: string): string {
    const home = os.homedir();
    if (p === home) return "~";
    if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
    return p;
}

/**
 * Interactive directory browser with navigation.
 *
 * Shows directories at the current path in a select list.
 * Users can navigate into subdirectories, go up to parent,
 * select the current directory, or type a custom path.
 */
export async function promptPath(options: {
    message?: string;
    defaultPath?: string;
    cwd?: string;
    maxDepth?: number;
}): Promise<string | null> {
    const startDir = options.cwd || process.cwd();
    let currentDir = path.resolve(startDir);

    while (true) {
        const dirEntries = await listDir(currentDir);
        const displayDir = displayPath(currentDir);

        // Build option list
        const menuOptions: Array<{ value: string; label: string; hint?: string }> = [
            {
                value: "__select__",
                label: pc.green("  Use this directory"),
                hint: displayDir,
            },
            {
                value: "__up__",
                label: `${pc.yellow("..")}  Parent directory`,
                hint: displayPath(path.dirname(currentDir)),
            },
            {
                value: "__type__",
                label: pc.blue("  Type a path"),
            },
        ];

        // Add directory entries (cap at 30 to keep list readable)
        const dirLimit = 30;
        const cappedEntries = dirEntries.slice(0, dirLimit);
        if (cappedEntries.length > 0) {
            menuOptions.push(
                ...cappedEntries.map((e) => ({
                    value: e.value,
                    label: `   ${e.label}`,
                    hint: e.hint,
                })),
            );
        }

        if (dirEntries.length > dirLimit) {
            menuOptions.push({
                value: "__type__",
                label: pc.dim(`   ... and ${dirEntries.length - dirLimit} more`),
                hint: "type path to access",
            });
        }

        if (dirEntries.length === 0) {
            menuOptions.push({
                value: "__empty__",
                label: pc.dim("   (empty directory)"),
            });
        }

        const choice = await select({
            message: `${options.message ?? "Select directory"} ${pc.dim(`[${displayDir}]`)}`,
            options: menuOptions,
        });

        if (isCancel(choice)) {
            cancel("Operation cancelled.");
            return null;
        }

        if (choice === "__select__") {
            return currentDir;
        }

        if (choice === "__up__") {
            const parent = path.dirname(currentDir);
            if (parent !== currentDir) {
                currentDir = parent;
            }
            continue;
        }

        if (choice === "__type__") {
            const typed = await text({
                message: "Enter path (absolute or relative, ~ supported):",
                placeholder: currentDir,
                initialValue: currentDir,
                validate: (v) =>
                    (v ?? "").trim().length > 0 ? undefined : "Path cannot be empty",
            });

            if (isCancel(typed)) continue;

            let resolved = String(typed).trim();
            // Expand ~ to home directory
            if (resolved.startsWith("~")) {
                resolved = path.join(os.homedir(), resolved.slice(1));
            }
            resolved = path.resolve(currentDir, resolved);

            try {
                const stat = await fs.stat(resolved);
                if (stat.isDirectory()) {
                    // Navigate into the typed directory instead of selecting immediately
                    currentDir = resolved;
                    continue;
                }
                // If it's a file, go to its parent
                currentDir = path.dirname(resolved);
                continue;
            } catch {
                // Path doesn't exist — offer to create or navigate to closest parent
                const createIt = await confirm({
                    message: `"${displayPath(resolved)}" doesn't exist. Create it?`,
                    initialValue: true,
                });

                if (isCancel(createIt) || !createIt) {
                    continue;
                }

                try {
                    await fs.mkdir(resolved, { recursive: true });
                    return resolved;
                } catch {
                    note("Failed to create directory. Check permissions.", "Error");
                    continue;
                }
            }
        }

        if (choice === "__empty__") continue;

        // User picked a directory entry — navigate into it
        const choicePath = choice as string;
        try {
            const stat = await fs.stat(choicePath);
            if (stat.isDirectory()) {
                currentDir = choicePath;
            }
        } catch {
            continue;
        }
    }
}
