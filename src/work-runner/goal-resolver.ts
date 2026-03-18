/**
 * Goal resolution — file-based goals, AI suggestions, workspace content checks.
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { log as clackLog, note, spinner, select, text, cancel, isCancel } from "@clack/prompts";
import { randomPhrase } from "../utils/spinner-phrases.js";

export const WORKSPACE_PROTECTED = new Set([".git", "teamclaw.config.json"]);

const SUPPORTED_GOAL_EXTENSIONS = [".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".rst", ".adoc"];

export function resolveGoalFromFile(
    input: string,
    workspaceDir?: string,
    logFn?: (level: "info" | "warn" | "error", msg: string) => void,
): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const hasValidExtension = SUPPORTED_GOAL_EXTENSIONS.some(ext => trimmed.endsWith(ext));
    if (!hasValidExtension) return null;

    const searchPaths: string[] = [];

    if (path.isAbsolute(trimmed)) {
        searchPaths.push(trimmed);
    } else {
        if (workspaceDir) {
            searchPaths.push(path.resolve(workspaceDir, trimmed));
        }
        searchPaths.push(path.resolve(process.cwd(), trimmed));
    }

    for (const absolutePath of searchPaths) {
        if (!existsSync(absolutePath)) continue;

        try {
            const content = readFileSync(absolutePath, "utf-8");
            const filename = path.basename(absolutePath);
            logFn?.("info", `📖 Goal loaded from file: ${filename}`);
            return content;
        } catch {
            continue;
        }
    }

    return null;
}

export async function suggestGoalFromWorkspace(
    workspacePath: string,
    currentGoal: string,
): Promise<string | null> {
    const s = spinner();
    try {
        s.start(randomPhrase("file"));
        const entryNames = await readdir(workspacePath);

        const keyFiles = ["docs/ARCHITECTURE.md", "DOCS/PLANNING.md", "README.md", "package.json"];
        let context = "";
        const maxPerFile = 2000;
        const maxTotal = 8000;

        for (const kf of keyFiles) {
            if (context.length >= maxTotal) break;
            try {
                const content = await readFile(path.join(workspacePath, kf), "utf-8");
                const truncated = content.slice(0, maxPerFile);
                context += `\n--- ${kf} ---\n${truncated}\n`;
            } catch {
                // file doesn't exist, skip
            }
        }

        const dirListing = entryNames.join(", ");
        const prompt = [
            "Given a workspace with these files:",
            dirListing,
            context ? "\nKey file contents:" + context : "",
            `\nThe previous goal was: "${currentGoal}"`,
            "\nSuggest an updated goal that accounts for the existing work. Respond with ONLY the goal text, no explanation.",
        ].join("\n");

        s.message(randomPhrase("ai"));
        // Goal suggestion via external CLI is disabled — provider integration pending.
        s.stop("AI goal suggestion is not available.");
        void prompt; // suppress unused warning
        return null;
    } catch {
        s.stop("Could not get AI suggestion.");
        return null;
    }
}

export async function checkWorkspaceContent(
    workspacePath: string,
    currentGoal: string,
    canRenderSpinner: boolean,
): Promise<{ goal: string; cleared: boolean }> {
    if (!canRenderSpinner) return { goal: currentGoal, cleared: false };

    let entryNames: { name: string; isFile: boolean; isDir: boolean }[];
    try {
        const raw = await readdir(workspacePath, { withFileTypes: true });
        entryNames = raw.map((e) => ({ name: String(e.name), isFile: e.isFile(), isDir: e.isDirectory() }));
    } catch {
        return { goal: currentGoal, cleared: false };
    }

    const userEntries = entryNames.filter((e) => !WORKSPACE_PROTECTED.has(e.name));
    if (userEntries.length === 0) return { goal: currentGoal, cleared: false };

    // Build summary
    const fileCount = userEntries.filter((e) => e.isFile).length;
    const dirCount = userEntries.filter((e) => e.isDir).length;
    const listed = userEntries.slice(0, 10).map((e) => e.name);
    const extra = userEntries.length - listed.length;
    let summary = `${fileCount} file(s), ${dirCount} dir(s)\n`;
    summary += listed.join(", ");
    if (extra > 0) summary += `, +${extra} more`;

    note(summary, "Existing workspace content");

    const action = await select({
        message: "Workspace already has content. What would you like to do?",
        options: [
            { value: "fresh", label: "Start fresh (remove existing files)" },
            { value: "keep", label: "Keep existing files" },
        ],
    });

    if (isCancel(action)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (action === "fresh") {
        for (const entry of userEntries) {
            try {
                await rm(path.join(workspacePath, entry.name), { recursive: true, force: true });
            } catch (err) {
                clackLog.warn(`Could not remove ${entry.name}: ${err}`);
            }
        }
        clackLog.info("Workspace cleared.");
        return { goal: currentGoal, cleared: true };
    }

    // Keep files — offer goal adjustment
    const goalAction = await select({
        message: "Adjust your goal for the existing workspace?",
        options: [
            { value: "keep_goal", label: "Keep current goal" },
            { value: "edit", label: "Edit goal manually" },
            { value: "ai", label: "AI-suggested goal" },
        ],
    });

    if (isCancel(goalAction)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (goalAction === "keep_goal") {
        return { goal: currentGoal, cleared: false };
    }

    if (goalAction === "edit") {
        const newGoal = await text({
            message: "Enter updated goal:",
            initialValue: currentGoal,
        });
        if (isCancel(newGoal) || !String(newGoal).trim()) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        return { goal: String(newGoal).trim(), cleared: false };
    }

    // AI suggestion
    const suggestion = await suggestGoalFromWorkspace(workspacePath, currentGoal);
    if (!suggestion) {
        clackLog.warn("AI suggestion failed. You can edit the goal manually.");
        const fallback = await text({
            message: "Enter updated goal:",
            initialValue: currentGoal,
        });
        if (isCancel(fallback) || !String(fallback).trim()) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        return { goal: String(fallback).trim(), cleared: false };
    }

    note(suggestion, "AI-suggested goal");

    const acceptAction = await select({
        message: "Use this suggestion?",
        options: [
            { value: "accept", label: "Accept" },
            { value: "edit", label: "Edit suggestion" },
            { value: "discard", label: "Discard (keep original)" },
        ],
    });

    if (isCancel(acceptAction)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (acceptAction === "accept") {
        return { goal: suggestion, cleared: false };
    }
    if (acceptAction === "edit") {
        const edited = await text({
            message: "Edit the suggested goal:",
            initialValue: suggestion,
        });
        if (isCancel(edited) || !String(edited).trim()) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        return { goal: String(edited).trim(), cleared: false };
    }

    return { goal: currentGoal, cleared: false };
}

export async function promptGoalChoice(): Promise<{ mode: "file" | "manual"; value: string }> {
    const choice = await select({
        message: "How would you like to input your goal?",
        options: [
            { label: "Type goal manually", value: "manual" },
            { label: "Load from file path", value: "file" },
        ],
    });

    if (isCancel(choice)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (choice === "file") {
        const filePath = await text({
            message: "Enter file path:",
            placeholder: "goal.md, requirements.txt, etc.",
        });

        if (isCancel(filePath) || !String(filePath).trim()) {
            cancel("Work session cancelled: no file path provided.");
            process.exit(0);
        }

        return { mode: "file", value: String(filePath).trim() };
    }

    console.log([
        "",
        "  Examples:",
        '  · "Add rate limiting to the auth API"',
        '  · "Build a caching layer for user profiles"',
        '  · "Write tests for the payment module"',
        '  · "Refactor the database queries in orders.ts"',
        "",
        "  Tip: Be specific. The more detail you give, the better",
        "  the team can plan.",
        "",
    ].join("\n"));

    const goalInput = await text({
        message: "What's your goal for this session?",
        placeholder: "Describe what you want to build or fix...",
    });

    if (isCancel(goalInput) || !String(goalInput).trim()) {
        cancel("Work session cancelled: no goal provided.");
        process.exit(0);
    }

    return { mode: "manual", value: String(goalInput).trim() };
}
