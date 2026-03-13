import { select, cancel, isCancel } from "@clack/prompts";
import fs from "node:fs/promises";
import path from "node:path";

export interface PathEntry {
    value: string;
    label: string;
    hint?: string;
}

async function scanDirectory(dirPath: string, maxDepth: number = 2, currentDepth: number = 0): Promise<PathEntry[]> {
    if (currentDepth >= maxDepth) return [];

    const entries: PathEntry[] = [];

    try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });

        for (const item of items) {
            if (item.name.startsWith(".")) continue;
            if (item.name === "node_modules") continue;
            if (item.name === "dist") continue;
            if (item.name === "build") continue;

            const fullPath = path.join(dirPath, item.name);

            if (item.isDirectory()) {
                entries.push({
                    value: fullPath,
                    label: `${item.name}/`,
                    hint: "directory",
                });

                if (currentDepth < maxDepth - 1) {
                    const subEntries = await scanDirectory(fullPath, maxDepth, currentDepth + 1);
                    entries.push(...subEntries);
                }
            } else if (item.isFile() && item.name.endsWith(".json")) {
                entries.push({
                    value: fullPath,
                    label: item.name,
                    hint: "file",
                });
            }
        }
    } catch {
        // Ignore permission errors
    }

    return entries;
}

export async function promptPath(options: {
    message?: string;
    defaultPath?: string;
    cwd?: string;
    maxDepth?: number;
}): Promise<string | null> {
    const cwd = options.cwd || process.cwd();
    const maxDepth = options.maxDepth || 2;

    const commonPaths: PathEntry[] = [
        { value: cwd, label: "Current directory", hint: path.basename(cwd) },
        { value: path.join(cwd, ".."), label: "Parent directory", hint: ".." },
        { value: path.join(cwd, "projects"), label: "projects/", hint: "subdirectory" },
        { value: path.join(cwd, "workspace"), label: "workspace/", hint: "subdirectory" },
    ];

    const scanBtn: PathEntry = {
        value: "__scan__",
        label: "🔍 Browse directories...",
        hint: "scan current directory",
    };

    const customBtn: PathEntry = {
        value: "__custom__",
        label: "⌨️  Type custom path...",
        hint: "enter path manually",
    };

    const initialOptions: PathEntry[] = [
        ...commonPaths.slice(0, 2),
        scanBtn,
        customBtn,
    ];

    let selectedValue: string | symbol = "";

    while (true) {
        selectedValue = await select({
            message: options.message || "Select workspace path:",
            options: initialOptions,
        });

        if (isCancel(selectedValue)) {
            cancel("Operation cancelled.");
            return null;
        }

        if (selectedValue === "__scan__") {
            const scanned = await scanDirectory(cwd, maxDepth);
            const scanOptions: PathEntry[] = [
                ...commonPaths,
                ...scanned.slice(0, 50),
                customBtn,
            ];

            const scannedChoice = await select({
                message: "Select a directory:",
                options: scanOptions,
            });

            if (isCancel(scannedChoice)) {
                continue;
            }

            if (scannedChoice === "__custom__") {
                const { text } = await import("@clack/prompts");
                const customPath = await text({
                    message: "Enter absolute or relative path:",
                    placeholder: "./my-project or /home/user/projects",
                });

                if (isCancel(customPath) || !String(customPath).trim()) {
                    continue;
                }

                const resolved = path.resolve(cwd, String(customPath).trim());
                try {
                    await fs.access(resolved);
                    return resolved;
                } catch {
                    const { confirm } = await import("@clack/prompts");
                    const create = await confirm({
                        message: `Directory doesn't exist. Create "${resolved}"?`,
                    });

                    if (isCancel(create) || !create) {
                        continue;
                    }

                    try {
                        await fs.mkdir(resolved, { recursive: true });
                        return resolved;
                    } catch {
                        continue;
                    }
                }
            }

            return scannedChoice as string;
        }

        if (selectedValue === "__custom__") {
            const { text } = await import("@clack/prompts");
            const customPath = await text({
                message: "Enter absolute or relative path:",
                placeholder: "./my-project or /home/user/projects",
            });

            if (isCancel(customPath) || !String(customPath).trim()) {
                continue;
            }

            const resolved = path.resolve(cwd, String(customPath).trim());
            try {
                await fs.access(resolved);
                return resolved;
            } catch {
                const { confirm } = await import("@clack/prompts");
                const create = await confirm({
                    message: `Directory doesn't exist. Create "${resolved}"?`,
                });

                if (isCancel(create) || !create) {
                    continue;
                }

                try {
                    await fs.mkdir(resolved, { recursive: true });
                    return resolved;
                } catch {
                    continue;
                }
            }
        }

        return selectedValue as string;
    }
}
