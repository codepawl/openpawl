/**
 * Setup Step 5: Goal — manual input, file loading, AI refinement.
 */

import {
    note,
    select,
    spinner,
    text,
} from "@clack/prompts";
import pc from "picocolors";
import os from "node:os";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { readTeamclawConfig } from "../../core/jsonConfigManager.js";
import { getDefaultGoal } from "../../core/configManager.js";
import { handleCancel, type WizardState } from "./connection.js";
import { randomPhrase } from "../../utils/spinner-phrases.js";

function detectGoalFiles(workspaceDir: string): Array<{ path: string; label: string }> {
    const candidates = [
        "GOAL.md", "GOAL.txt", "goal.md", "goal.txt",
        "SPEC.md", "SPEC.txt", "spec.md", "spec.txt",
        "BRIEF.md", "BRIEF.txt", "brief.md", "brief.txt",
        "PRD.md", "prd.md", "PRD.txt", "prd.txt",
        "REQUIREMENTS.md", "requirements.md", "requirements.txt",
        "OBJECTIVE.md", "objective.md", "OBJECTIVE.txt", "objective.txt",
        "PLAN.md", "plan.md", "PLAN.txt", "plan.txt",
        "SCOPE.md", "scope.md",
    ];

    const resolvedWorkspace = path.resolve(workspaceDir);
    const searchDirs = [resolvedWorkspace];
    if (process.cwd() !== resolvedWorkspace) searchDirs.push(process.cwd());

    const found: Array<{ path: string; label: string }> = [];
    const seen = new Set<string>();

    for (const dir of searchDirs) {
        for (const name of candidates) {
            const full = path.join(dir, name);
            if (seen.has(full)) continue;
            seen.add(full);
            if (existsSync(full)) {
                const rel = path.relative(process.cwd(), full);
                const label = rel.startsWith("..") ? full : `./${rel}`;
                const source = dir === resolvedWorkspace ? "workspace" : "cwd";
                found.push({ path: full, label: `${label}  ${pc.dim(`(${source})`)}` });
            }
        }
    }
    return found;
}

async function promptManualFilePath(): Promise<string> {
    const input = handleCancel(
        await text({
            message: "Path to goal file (absolute or relative, ~ supported):",
            placeholder: "./GOAL.md",
            validate: (v) => {
                if (!(v ?? "").trim()) return "Path cannot be empty";
                let resolved = v!.trim();
                if (resolved.startsWith("~")) {
                    resolved = path.join(os.homedir(), resolved.slice(1));
                }
                resolved = path.resolve(resolved);
                if (!existsSync(resolved)) return `File not found: ${resolved}`;
                return undefined;
            },
        }),
    ) as string;

    let resolved = input.trim();
    if (resolved.startsWith("~")) {
        resolved = path.join(os.homedir(), resolved.slice(1));
    }
    return path.resolve(resolved);
}

async function pickGoalFile(workspaceDir: string): Promise<string | null> {
    const detected = detectGoalFiles(workspaceDir);

    const fileOptions: Array<{ value: string; label: string; hint?: string }> = [];

    if (detected.length > 0) {
        for (const f of detected) {
            fileOptions.push({ value: f.path, label: f.label, hint: "detected" });
        }
    }
    fileOptions.push({ value: "__manual__", label: "Enter path manually..." });

    let filePath: string;

    if (fileOptions.length === 1) {
        filePath = await promptManualFilePath();
        if (!filePath) return null;
    } else {
        const picked = handleCancel(
            await select({
                message: "Select a goal file:",
                options: fileOptions,
            }),
        ) as string;

        if (picked === "__manual__") {
            filePath = await promptManualFilePath();
            if (!filePath) return null;
        } else {
            filePath = picked;
        }
    }

    return filePath;
}

async function promptGoalText(initialValue: string): Promise<string> {
    const goalInput = handleCancel(
        await text({
            message: "What do you want to build?\n  (Describe the project goal for the team.)",
            initialValue,
            placeholder: initialValue,
        }),
    ) as string;
    return goalInput.trim() || initialValue;
}

async function refineGoalWithAI(state: WizardState, draft: string): Promise<string> {
    const apiPort = state.apiPort || parseInt(state.port, 10) + 2;
    const apiBase = `http://${state.ip}:${apiPort}`;
    const chatUrl = `${apiBase}/v1/chat/completions`;
    const model = state.selectedModel || state.detectedModel || "gateway-default";

    const s = spinner();
    s.start(randomPhrase("ai"));

    try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (state.token) headers.Authorization = `Bearer ${state.token}`;

        const res = await fetch(chatUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: "system" as const,
                        content: [
                            "You are a project planning assistant.",
                            "The user will provide a rough project goal or description.",
                            "Refine it into a clear, actionable goal statement that a team of AI agents can work from.",
                            "Keep it concise (2-5 sentences). Focus on: what to build, key requirements, and success criteria.",
                            "Return ONLY the refined goal text, no markdown headers or extra formatting.",
                        ].join(" "),
                    },
                    { role: "user" as const, content: draft },
                ],
                temperature: 0.7,
                stream: false,
            }),
            signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
            s.stop(pc.yellow("AI refinement failed — using your draft as-is."));
            return draft;
        }

        const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const refined = data.choices?.[0]?.message?.content?.trim();

        if (!refined) {
            s.stop(pc.yellow("AI returned empty response — using your draft as-is."));
            return draft;
        }

        s.stop("AI refinement complete!");

        note(
            [
                `${pc.dim("Your draft:")}`,
                draft.length > 150 ? draft.slice(0, 147) + "..." : draft,
                "",
                `${pc.green("Refined:")}`,
                refined.length > 300 ? refined.slice(0, 297) + "..." : refined,
            ].join("\n"),
            "Goal Refinement",
        );

        const pick = handleCancel(
            await select({
                message: "Which version to use?",
                options: [
                    { value: "refined", label: "Use refined version" },
                    { value: "draft", label: "Keep my original draft" },
                    { value: "edit", label: "Edit the refined version" },
                ],
            }),
        ) as string;

        if (pick === "draft") return draft;
        if (pick === "edit") return await promptGoalText(refined);
        return refined;
    } catch {
        s.stop(pc.yellow("Could not reach AI — using your draft as-is."));
        return draft;
    }
}

export async function stepGoal(state: WizardState): Promise<void> {
    const tc = readTeamclawConfig();
    const existingGoal = (tc.data as Record<string, unknown>).goal as string | undefined;
    const defaultGoal = existingGoal?.trim() || getDefaultGoal();

    const method = handleCancel(
        await select({
            message: "How would you like to set the goal?",
            options: [
                { value: "type", label: "Type it manually" },
                { value: "file", label: "Load from a file (.txt, .md, .goal)" },
                { value: "refine", label: "Type a draft, then refine with AI" },
            ],
        }),
    ) as string;

    if (method === "file") {
        const resolved = await pickGoalFile(state.workspaceDir);
        if (resolved === null) {
            state.goal = await promptGoalText(defaultGoal);
            return;
        }

        const content = readFileSync(resolved, "utf-8").trim();
        if (!content) {
            note("File is empty. Falling back to manual input.", "Warning");
            state.goal = await promptGoalText(defaultGoal);
            return;
        }

        const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
        const preview = firstLine.length > 80
            ? firstLine.slice(0, 77) + "..."
            : firstLine;
        const lines = content.split("\n").length;
        const chars = content.length;

        const useIt = handleCancel(
            await select({
                message: `Loaded ${path.basename(resolved)} (${lines} lines, ${chars} chars)\n  ${pc.dim(preview)}`,
                options: [
                    { value: "use", label: "Use as-is" },
                    { value: "refine", label: "Refine with AI first" },
                    { value: "edit", label: "Edit manually" },
                ],
            }),
        ) as string;

        if (useIt === "use") {
            state.goal = content;
            return;
        }
        if (useIt === "refine") {
            state.goal = await refineGoalWithAI(state, content);
            return;
        }
        state.goal = await promptGoalText(content);
        return;
    }

    if (method === "refine") {
        const draft = await promptGoalText(defaultGoal);
        state.goal = await refineGoalWithAI(state, draft);
        return;
    }

    state.goal = await promptGoalText(defaultGoal);
}
