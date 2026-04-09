/**
 * Setup Step 5: Goal — manual input, file loading, AI refinement.
 */

import {
    confirm,
    note,
    select,
    spinner,
    text,
} from "@clack/prompts";
import { searchableSelect, clampSelectOptions } from "../../utils/searchable-select.js";
import pc from "picocolors";
import os from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readOpenpawlConfig } from "../../core/jsonConfigManager.js";
import { getDefaultGoal } from "../../core/configManager.js";
import { handleCancel, type WizardState } from "./connection.js";
import { randomPhrase } from "../../utils/spinner-phrases.js";

function detectGoalFiles(workspaceDir: string, projectName?: string): Array<{ path: string; label: string }> {
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
    const searchDirs = new Set<string>([resolvedWorkspace]);

    // Also search the project directory inside the workspace
    if (projectName) {
        const projectDir = path.join(resolvedWorkspace, projectName);
        if (existsSync(projectDir)) searchDirs.add(projectDir);
    }

    const cwd = process.cwd();
    searchDirs.add(cwd);

    // Walk up from cwd to find goal files in parent directories (stop at home or root)
    const stopAt = os.homedir();
    let parent = path.dirname(cwd);
    while (parent !== cwd && parent !== stopAt && parent !== path.dirname(parent)) {
        searchDirs.add(parent);
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
    }

    const found: Array<{ path: string; label: string }> = [];
    const seen = new Set<string>();

    const dirLabels: Record<string, string> = {
        [resolvedWorkspace]: "workspace",
        [cwd]: "cwd",
    };
    if (projectName) {
        dirLabels[path.join(resolvedWorkspace, projectName)] = "project";
    }

    for (const dir of searchDirs) {
        for (const name of candidates) {
            const full = path.join(dir, name);
            if (seen.has(full)) continue;
            seen.add(full);
            if (existsSync(full)) {
                const rel = path.relative(cwd, full);
                const label = rel.startsWith("..") ? full : `./${rel}`;
                const source = dirLabels[dir] ?? "parent";
                found.push({ path: full, label: `${label}  ${pc.dim(`(${source})`)}` });
            }
        }
    }
    return found;
}

async function promptManualFilePath(): Promise<string> {
    const input = handleCancel(
        await text({
            message: "Path to your goal file:",
            placeholder: "./GOAL.md",
            validate: (v) => {
                if (!(v ?? "").trim()) return "Path cannot be empty";
                return undefined;
            },
        }),
    ) as string;

    let resolved = input.trim();
    if (resolved.startsWith("~")) {
        resolved = path.join(os.homedir(), resolved.slice(1));
    }
    resolved = path.resolve(resolved);

    if (!existsSync(resolved)) {
        const create = handleCancel(
            await confirm({
                message: `Can't find ${resolved} — create a new file there?`,
                initialValue: true,
            }),
        ) as boolean;

        if (create) {
            mkdirSync(path.dirname(resolved), { recursive: true });
            writeFileSync(resolved, "", "utf-8");
            note(`Created ${resolved}`, "New file");
        }
    }

    return resolved;
}

async function pickGoalFile(workspaceDir: string, projectName?: string): Promise<string | null> {
    const detected = detectGoalFiles(workspaceDir, projectName);

    const fileOptions: Array<{ value: string; label: string; hint?: string }> = [];

    if (detected.length > 0) {
        for (const f of detected) {
            fileOptions.push({ value: f.path, label: f.label, hint: "found in your folder" });
        }
    }
    fileOptions.push({ value: "__manual__", label: "Enter path manually..." });

    let filePath: string;

    if (fileOptions.length === 1) {
        filePath = await promptManualFilePath();
        if (!filePath) return null;
    } else {
        const picked = handleCancel(
            await searchableSelect({
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
            message: "Describe what you want to build:",
            initialValue,
            placeholder: initialValue,
        }),
    ) as string;
    return goalInput.trim() || initialValue;
}

async function readSSEStream(
    res: Response,
    onToken: (accumulated: string) => void,
): Promise<string> {
    const body = res.body;
    if (!body) return "";

    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";

    const reader = body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;
                const payload = trimmed.slice(6);
                if (payload === "[DONE]") continue;

                try {
                    const parsed = JSON.parse(payload) as {
                        choices?: Array<{ delta?: { content?: string } }>;
                    };
                    const content = parsed.choices?.[0]?.delta?.content ?? "";
                    if (content) {
                        accumulated += content;
                        onToken(accumulated);
                    }
                } catch {
                    // skip malformed chunks
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    return accumulated.trim();
}

// Build chat completion URL and headers from the first provider entry.
function resolveProviderEndpoint(state: WizardState): {
    chatUrl: string;
    model: string;
    headers: Record<string, string>;
} | null {
    const provider = state.providerEntries[0];
    if (!provider) return null;

    const headers: Record<string, string> = { "Content-Type": "application/json" };

    const PROVIDER_BASES: Record<string, string> = {
        anthropic: "https://api.anthropic.com/v1",
        openai: "https://api.openai.com/v1",
        openrouter: "https://openrouter.ai/api/v1",
        deepseek: "https://api.deepseek.com/v1",
        groq: "https://api.groq.com/openai/v1",
        ollama: "http://localhost:11434/v1",
    };

    const DEFAULT_MODELS: Record<string, string> = {
        anthropic: "claude-sonnet-4-20250514",
        openai: "gpt-4o",
        openrouter: "anthropic/claude-sonnet-4-20250514",
        ollama: "llama3.1",
        deepseek: "deepseek-chat",
        groq: "llama-3.3-70b-versatile",
    };

    const baseURL = provider.baseURL || PROVIDER_BASES[provider.type] || "";
    if (!baseURL) return null;

    const chatUrl = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
    const model = state.selectedModel || provider.model || DEFAULT_MODELS[provider.type] || "default";

    if (provider.apiKey) {
        headers.Authorization = `Bearer ${provider.apiKey}`;
    }

    return { chatUrl, model, headers };
}

async function refineGoalWithAI(state: WizardState, draft: string): Promise<string> {
    const endpoint = resolveProviderEndpoint(state);
    if (!endpoint) {
        return draft;
    }
    const { chatUrl, model, headers } = endpoint;

    const s = spinner();
    s.start(randomPhrase("ai"));

    try {
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
                stream: true,
            }),
            signal: AbortSignal.timeout(60000),
        });

        if (!res.ok) {
            s.stop(pc.yellow("Couldn't improve it — using your original."));
            return draft;
        }

        const refined = await readSSEStream(res, (partial) => {
            const display = partial.length > 80 ? "..." + partial.slice(-77) : partial;
            s.message(`Refining: ${pc.dim(display)}`);
        });

        if (!refined) {
            s.stop(pc.yellow("AI returned nothing — keeping your original."));
            return draft;
        }

        s.stop("Done — here's the improved version:");

        note(
            [
                `${pc.dim("Your draft:")}`,
                draft.length > 150 ? draft.slice(0, 147) + "..." : draft,
                "",
                `${pc.green("Refined:")}`,
                refined.length > 300 ? refined.slice(0, 297) + "..." : refined,
            ].join("\n"),
            "AI improved your goal",
        );

        const pick = handleCancel(
            await select({
                message: "Which version do you prefer?",
                options: clampSelectOptions([
                    { value: "refined", label: "Use the improved version" },
                    { value: "draft", label: "Keep my original" },
                    { value: "edit", label: "Edit the improved version" },
                ]),
            }),
        ) as string;

        if (pick === "draft") return draft;
        if (pick === "edit") return await promptGoalText(refined);
        return refined;
    } catch {
        s.stop(pc.yellow("Couldn't reach AI — keeping your original."));
        return draft;
    }
}

export async function stepGoal(state: WizardState): Promise<void> {
    const tc = readOpenpawlConfig();
    const existingGoal = (tc.data as Record<string, unknown>).goal as string | undefined;
    const defaultGoal = existingGoal?.trim() || getDefaultGoal();

    const method = handleCancel(
        await select({
            message: "What does your team need to build?",
            options: clampSelectOptions([
                { value: "type", label: "Describe it now" },
                { value: "file", label: "Load from a file" },
                { value: "refine", label: "Draft it — I'll help refine with AI" },
            ]),
        }),
    ) as string;

    if (method === "file") {
        const resolved = await pickGoalFile(process.cwd(), state.projectName);
        if (resolved === null) {
            state.goal = await promptGoalText(defaultGoal);
            return;
        }

        const content = readFileSync(resolved, "utf-8").trim();
        if (!content) {
            note("That file is empty — let's describe the goal here instead.", "Empty file");
            state.goal = await promptGoalText(defaultGoal);
            return;
        }

        const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
        const preview = firstLine.length > 80
            ? firstLine.slice(0, 77) + "..."
            : firstLine;
        const useIt = handleCancel(
            await select({
                message: `Loaded ${path.basename(resolved)}\n  ${pc.dim(preview)}`,
                options: clampSelectOptions([
                    { value: "use", label: "Use this" },
                    { value: "refine", label: "Improve with AI" },
                    { value: "edit", label: "Edit it myself" },
                ]),
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
