/**
 * Unified TeamClaw Setup Wizard — `teamclaw setup` / `teamclaw init`
 *
 * 6-step sequential wizard:
 *   Step 1: Connection  — auto-detect or prompt, verify with retry loop
 *   Step 2: Workspace   — choose workspace directory
 *   Step 3: Project     — name the project within the workspace
 *   Step 4: Model       — select from available models
 *   Step 5: Goal        — set the team's objective
 *   Step 6: Team        — pick a template or build custom roster
 *   Summary + Save
 */

import {
    confirm,
    intro,
    isCancel,
    note,
    outro,
    password,
    select,
    spinner,
    text,
    cancel,
} from "@clack/prompts";
import pc from "picocolors";
import os from "node:os";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
    readTeamclawConfig,
    writeTeamclawConfig,
} from "../core/jsonConfigManager.js";
import {
    setOpenClawWorkerUrl,
    setOpenClawHttpUrl,
    setOpenClawModel,
    setOpenClawToken,
    setOpenClawChatEndpoint,
} from "../core/config.js";
import { logger } from "../core/logger.js";
import {
    writeGlobalConfig,
    readGlobalConfig,
    type TeamClawGlobalConfig,
} from "../core/global-config.js";
import { readLocalOpenClawConfig } from "../core/discovery.js";
import { listAvailableModels } from "../core/model-config.js";
import { TEAM_TEMPLATES, type RosterEntry } from "../core/team-templates.js";
import { getRoleTemplate } from "../core/bot-definitions.js";
import { getDefaultGoal } from "../core/configManager.js";
import { writeConfig } from "../onboard/writeConfig.js";
import { promptPath } from "../utils/path-autocomplete.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WizardState {
    ip: string;
    port: string;
    token: string;
    apiPort: number;
    detectedModel: string | null;
    workspaceDir: string;
    projectName: string;
    selectedModel: string;
    goal: string;
    roster: RosterEntry[];
    templateId: string;
    managed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function handleCancel<T>(v: T): T {
    if (isCancel(v)) {
        cancel("Setup cancelled.");
        process.exit(0);
    }
    return v;
}

function isLocalHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
}

/**
 * Ping the gateway to verify connectivity and auto-detect model.
 *
 * OpenClaw port layout:
 *   WS  gateway  port (e.g. 8001)
 *   API HTTP     port (WS+2, e.g. 8003)
 */
async function pingGateway(
    ip: string,
    port: string,
    token: string,
): Promise<{ reachable: boolean; apiPort: number; model: string | null }> {
    const wsPort = parseInt(port, 10);
    const apiPort = wsPort + 2;

    const headers: Record<string, string> = {};
    if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;

    const wsBase = `http://${ip}:${wsPort}`;
    let wsReachable = false;
    for (const p of ["/__openclaw__/api/config", "/api/status", "/"]) {
        try {
            const res = await fetch(`${wsBase}${p}`, {
                headers,
                signal: AbortSignal.timeout(3000),
            });
            wsReachable = true;
            if (res.ok) {
                const data = (await res.json()) as Record<string, unknown>;
                const flatModel = data.model as string | undefined;
                if (typeof flatModel === "string" && flatModel.trim().length > 0) {
                    return { reachable: true, apiPort, model: flatModel.trim() };
                }
            }
            break;
        } catch {
            // try next path
        }
    }

    const apiBase = `http://${ip}:${apiPort}`;
    const modelEndpoints = [
        `${apiBase}/v1/models`,
        `${apiBase}/__openclaw__/api/config`,
        `${apiBase}/api/config`,
    ];

    for (const url of modelEndpoints) {
        try {
            const res = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(4000),
            });
            if (!res.ok) continue;

            const data = (await res.json()) as Record<string, unknown>;
            const models = (data.data as Array<{ id?: string }> | undefined) ?? [];
            const firstModel = models.find(
                (m) => typeof m.id === "string" && m.id.trim().length > 0,
            )?.id;
            if (firstModel) return { reachable: true, apiPort, model: firstModel.trim() };

            const flatModel = data.model as string | undefined;
            if (typeof flatModel === "string" && flatModel.trim().length > 0)
                return { reachable: true, apiPort, model: flatModel.trim() };

            return { reachable: true, apiPort, model: null };
        } catch {
            // try next
        }
    }

    if (wsReachable) {
        return { reachable: true, apiPort, model: null };
    }

    return { reachable: false, apiPort, model: null };
}

// ---------------------------------------------------------------------------
// Step 1: Connection
// ---------------------------------------------------------------------------

async function stepConnection(state: WizardState): Promise<void> {
    // Auto-detect from local OpenClaw config and global TeamClaw config
    const openclawConfig = readLocalOpenClawConfig();
    const globalConfig = readGlobalConfig();

    const existingIp = globalConfig?.gatewayHost ?? openclawConfig?.port ? "127.0.0.1" : null;
    const existingPort = globalConfig?.gatewayPort?.toString()
        ?? openclawConfig?.port?.toString()
        ?? null;
    const existingToken = globalConfig?.token ?? openclawConfig?.token ?? "";

    if (existingPort) {
        const displayUrl = `ws://${existingIp ?? "127.0.0.1"}:${existingPort}`;
        const useExisting = handleCancel(
            await confirm({
                message: `Found OpenClaw at ${pc.cyan(displayUrl)}. Use this?`,
                initialValue: true,
            }),
        ) as boolean;

        if (useExisting) {
            state.ip = existingIp ?? "127.0.0.1";
            state.port = existingPort;
            state.token = existingToken;
            state.managed = globalConfig?.managedGateway ?? true;
        } else {
            await promptConnectionDetails(state, openclawConfig);
        }
    } else {
        await promptConnectionDetails(state, openclawConfig);
    }

    // Verify phase — must succeed before proceeding
    await verifyConnection(state);
}

async function promptConnectionDetails(
    state: WizardState,
    openclawConfig: ReturnType<typeof readLocalOpenClawConfig>,
): Promise<void> {
    const defaultPort = openclawConfig?.port?.toString() ?? "18789";
    const defaultIp = "127.0.0.1";

    const ipInput = handleCancel(
        await text({
            message: "Gateway IP / Hostname:",
            initialValue: defaultIp,
            placeholder: defaultIp,
            validate: (v) =>
                (v ?? "").trim().length > 0 ? undefined : "IP cannot be empty",
        }),
    ) as string;
    state.ip = ipInput.trim() || defaultIp;

    const portInput = handleCancel(
        await text({
            message: "Gateway Port:",
            initialValue: defaultPort,
            placeholder: defaultPort,
            validate: (v) => {
                const n = Number(v?.trim());
                return Number.isInteger(n) && n > 0 && n <= 65535
                    ? undefined
                    : "Port must be a number between 1 and 65535";
            },
        }),
    ) as string;
    state.port = portInput.trim() || defaultPort;

    const tokenInput = handleCancel(
        await password({
            message: "Gateway Auth Token (press Enter to skip if auth is disabled):",
        }),
    ) as string;
    state.token = (tokenInput ?? "").trim() || openclawConfig?.token || "";

    state.managed = isLocalHost(state.ip);
}

async function verifyConnection(state: WizardState): Promise<void> {
    while (true) {
        const s = spinner();
        s.start(`Pinging gateway at ${state.ip}:${state.port}...`);

        const result = await pingGateway(state.ip, state.port, state.token);

        if (result.reachable) {
            state.apiPort = result.apiPort;
            state.detectedModel = result.model ?? null;
            const modelLabel = result.model ? ` (model: ${pc.cyan(result.model)})` : "";
            s.stop(`${pc.green("Gateway is reachable!")}${modelLabel}`);
            return;
        }

        s.stop(pc.yellow(`Could not reach gateway at ${state.ip}:${state.port}`));

        const action = handleCancel(
            await select({
                message: "What would you like to do?",
                options: [
                    { value: "retry", label: "Retry connection" },
                    { value: "edit", label: "Edit connection details" },
                    { value: "cancel", label: "Cancel setup" },
                ],
            }),
        ) as string;

        if (action === "cancel") {
            cancel("Setup cancelled.");
            process.exit(0);
        }

        if (action === "edit") {
            await promptConnectionDetails(state, readLocalOpenClawConfig());
        }
        // "retry" loops back to top
    }
}

// ---------------------------------------------------------------------------
// Step 2: Workspace
// ---------------------------------------------------------------------------

async function stepWorkspace(state: WizardState): Promise<void> {
    const localDefault = path.resolve("./teamclaw-workspace");
    const homeDefault = path.join(os.homedir(), ".teamclaw", "workspace");

    // Check for previously used workspace path from global or project config
    const globalConfig = readGlobalConfig();
    const tc = readTeamclawConfig();
    const projectWorkspace = (tc.data as Record<string, unknown>).workspace_dir as string | undefined;
    const lastUsedDir =
        globalConfig?.workspaceDir?.trim() ||
        projectWorkspace?.trim() ||
        null;
    const isLastUsedUnique =
        lastUsedDir &&
        lastUsedDir !== localDefault &&
        lastUsedDir !== homeDefault;

    // Determine which option to pre-select based on history
    let initialValue: string | undefined;
    if (isLastUsedUnique) {
        initialValue = "last";
    } else if (lastUsedDir === homeDefault) {
        initialValue = "home";
    } else if (lastUsedDir === localDefault) {
        initialValue = "local";
    }

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    if (isLastUsedUnique) {
        options.push({
            value: "last",
            label: `Last used (${pc.dim(lastUsedDir)})`,
            hint: "previous session",
        });
    }
    options.push(
        {
            value: "local",
            label: `Local directory (${pc.dim(localDefault)})`,
            hint: lastUsedDir === localDefault ? "previous session" : undefined,
        },
        {
            value: "home",
            label: `Home directory (${pc.dim(homeDefault)})`,
            hint: lastUsedDir === homeDefault ? "previous session" : undefined,
        },
        { value: "custom", label: "Custom path..." },
    );

    const choice = handleCancel(
        await select({
            message: "Where should TeamClaw store workspace files?",
            options,
            initialValue,
        }),
    ) as string;

    if (choice === "last") {
        state.workspaceDir = lastUsedDir!;
    } else if (choice === "local") {
        state.workspaceDir = localDefault;
    } else if (choice === "home") {
        state.workspaceDir = homeDefault;
    } else {
        const selected = await promptPath({
            message: "Select workspace directory",
            cwd: process.cwd(),
        });
        if (selected === null) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        state.workspaceDir = selected;
    }
}

// ---------------------------------------------------------------------------
// Step 3: Project Name
// ---------------------------------------------------------------------------

async function stepProject(state: WizardState): Promise<void> {
    // Try to detect a project name from existing config, workspace dir, or git repo
    const tc = readTeamclawConfig();
    const existingName = (tc.data as Record<string, unknown>).project_name as string | undefined;
    const dirName = path.basename(state.workspaceDir);
    const cwdName = path.basename(process.cwd());

    // Build detected name: existing config > workspace dir basename > cwd basename
    const detected = existingName?.trim() || dirName || cwdName || "";

    if (detected) {
        const choice = handleCancel(
            await select({
                message: "Project name:",
                options: [
                    {
                        value: detected,
                        label: `Use "${detected}"`,
                        hint: existingName ? "from config" : "from directory name",
                    },
                    { value: "__custom__", label: "Enter a different name..." },
                    { value: "__skip__", label: "Skip (no project name)" },
                ],
            }),
        ) as string;

        if (choice === "__skip__") {
            state.projectName = "";
            return;
        }

        if (choice !== "__custom__") {
            state.projectName = choice;
            return;
        }
    }

    const nameInput = handleCancel(
        await text({
            message: "Project name:",
            initialValue: "",
            placeholder: "my-awesome-project",
            validate: (v) =>
                (v ?? "").trim().length > 0 ? undefined : "Project name cannot be empty",
        }),
    ) as string;
    state.projectName = nameInput.trim();
}

// ---------------------------------------------------------------------------
// Step 4: Model
// ---------------------------------------------------------------------------

async function stepModel(state: WizardState): Promise<void> {
    const s = spinner();
    s.start("Fetching available models...");

    let models: string[] = [];
    try {
        models = await listAvailableModels();
    } catch {
        // ignore — will fall back to detected model or manual entry
    }

    s.stop(models.length > 0
        ? `Found ${models.length} available model(s)`
        : "No models discovered from gateway");

    if (models.length > 0) {
        const options: Array<{ value: string; label: string }> = models.map((m) => ({
            value: m,
            label: m,
        }));
        options.push({ value: "__custom", label: "Enter custom model..." });

        const picked = handleCancel(
            await select({
                message: "Select a model:",
                options,
                initialValue: state.detectedModel && models.includes(state.detectedModel)
                    ? state.detectedModel
                    : models[0],
            }),
        ) as string;

        if (picked === "__custom") {
            const custom = handleCancel(
                await text({
                    message: "Enter model name:",
                    placeholder: state.detectedModel ?? "gateway-default",
                    initialValue: state.detectedModel ?? "",
                }),
            ) as string;
            state.selectedModel = custom.trim() || "gateway-default";
        } else {
            state.selectedModel = picked;
        }
    } else if (state.detectedModel) {
        note(`Detected model from gateway: ${pc.cyan(state.detectedModel)}`, "Model");
        const useDetected = handleCancel(
            await confirm({
                message: `Use ${state.detectedModel}?`,
                initialValue: true,
            }),
        ) as boolean;

        if (useDetected) {
            state.selectedModel = state.detectedModel;
        } else {
            const custom = handleCancel(
                await text({
                    message: "Enter model name:",
                    placeholder: "gateway-default",
                }),
            ) as string;
            state.selectedModel = custom.trim() || "gateway-default";
        }
    } else {
        const custom = handleCancel(
            await text({
                message: "Enter model name (leave empty to let gateway decide):",
                placeholder: "gateway-default",
                initialValue: "",
            }),
        ) as string;
        state.selectedModel = custom.trim() || "gateway-default";
    }
}

// ---------------------------------------------------------------------------
// Step 5: Goal
// ---------------------------------------------------------------------------

async function stepGoal(state: WizardState): Promise<void> {
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
            // User cancelled file pick — fall back to manual
            state.goal = await promptGoalText(defaultGoal);
            return;
        }

        const content = readFileSync(resolved, "utf-8").trim();
        if (!content) {
            note("File is empty. Falling back to manual input.", "Warning");
            state.goal = await promptGoalText(defaultGoal);
            return;
        }

        // Show a short single-line preview
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
        // "edit" — fall through to manual input with content pre-filled
        state.goal = await promptGoalText(content);
        return;
    }

    if (method === "refine") {
        const draft = await promptGoalText(defaultGoal);
        state.goal = await refineGoalWithAI(state, draft);
        return;
    }

    // "type"
    state.goal = await promptGoalText(defaultGoal);
}

/** Scan workspace dir (primary) and cwd for goal/spec files. */
function detectGoalFiles(workspaceDir: string): Array<{ path: string; label: string }> {
    // Goal-specific file names only — no generic files like README
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

    // Search workspace first (most relevant), then cwd as fallback
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
        // No files detected, go straight to manual
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
    const wsUrl = `ws://${state.ip}:${state.port}`;
    const apiPort = state.apiPort || parseInt(state.port, 10) + 2;
    const apiBase = `http://${state.ip}:${apiPort}`;
    const chatUrl = `${apiBase}/v1/chat/completions`;
    const model = state.selectedModel || state.detectedModel || "gateway-default";

    const s = spinner();
    s.start("Refining goal with AI...");

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

        // Show both versions
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

// ---------------------------------------------------------------------------
// Step 6: Team
// ---------------------------------------------------------------------------

function formatTemplateSlots(template: { slots: Array<{ role_id: string; count: number }> }): string {
    return template.slots
        .map((slot) => {
            const role = getRoleTemplate(slot.role_id);
            const name = role?.name ?? slot.role_id;
            return `${slot.count}x ${name}`;
        })
        .join(", ");
}

async function stepTeam(state: WizardState): Promise<void> {
    const templateEntries = Object.entries(TEAM_TEMPLATES);
    const options: Array<{ value: string; label: string; hint?: string }> = templateEntries.map(
        ([id, tmpl]) => ({
            value: id,
            label: `${tmpl.name} ${pc.dim("—")} ${tmpl.description}`,
            hint: formatTemplateSlots(tmpl),
        }),
    );
    options.push({ value: "__custom", label: "Custom..." });

    const picked = handleCancel(
        await select({
            message: "Choose a team template:",
            options,
        }),
    ) as string;

    if (picked === "__custom") {
        state.roster = await customTeamBuilder();
        state.templateId = "custom";
    } else {
        const template = TEAM_TEMPLATES[picked]!;
        state.templateId = picked;
        state.roster = template.slots.map((slot) => {
            const role = getRoleTemplate(slot.role_id);
            return {
                role: role?.name ?? slot.role_id,
                count: slot.count,
                description: role ? role.skills.join(", ") : "",
            };
        });
    }
}

async function customTeamBuilder(): Promise<RosterEntry[]> {
    const sizeInput = handleCancel(
        await text({
            message: "Total number of bots in your team?",
            initialValue: "4",
            placeholder: "4",
            validate: (v) => {
                const n = Number(v?.trim());
                if (!Number.isInteger(n) || n < 1) return "Enter an integer >= 1.";
                if (n > 200) return "Please keep team size <= 200.";
                return undefined;
            },
        }),
    ) as string;
    const totalCapacity = parseInt(sizeInput.trim(), 10) || 4;

    const roster: RosterEntry[] = [];

    while (true) {
        const currentAssigned = roster.reduce((sum, r) => sum + r.count, 0);
        const remaining = totalCapacity - currentAssigned;

        note(
            `Assigned: ${currentAssigned}/${totalCapacity} bots.\nRoster: ${
                roster.length === 0
                    ? "No roles assigned yet."
                    : roster.map((r) => `${r.count}x ${r.role}`).join(", ")
            }`,
            "Current roster",
        );

        const action = handleCancel(
            await select({
                message: "What would you like to do?",
                options: [
                    { label: "Confirm and Continue", value: "confirm" },
                    { label: "Add a custom role", value: "add" },
                    { label: "Edit a role", value: "edit" },
                    { label: "Remove a role", value: "remove" },
                ],
            }),
        ) as string;

        if (action === "confirm") {
            if (currentAssigned < totalCapacity) {
                note("Please assign all bots before confirming.", "Roster incomplete");
                continue;
            }
            if (currentAssigned > totalCapacity) {
                note("Assigned bots exceed total team size. Please reduce counts.", "Roster exceeds capacity");
                continue;
            }
            return roster;
        }

        if (action === "add") {
            if (remaining <= 0) {
                note("No remaining capacity. Edit or remove existing roles to free up bots.", "No capacity");
                continue;
            }

            const roleName = (handleCancel(
                await text({
                    message: "Role name?",
                    placeholder: "Backend Coder",
                    validate: (v) =>
                        (v ?? "").trim().length > 0 ? undefined : "Role name cannot be empty.",
                }),
            ) as string).trim();

            const description = (handleCancel(
                await text({
                    message: "Role description?",
                    placeholder: "Focuses on backend services, APIs, and data models.",
                }),
            ) as string).trim();

            const countInput = handleCancel(
                await text({
                    message: `How many bots for "${roleName}"? (Remaining: ${remaining})`,
                    initialValue: String(Math.min(remaining, 1)),
                    validate: (v) => {
                        const n = Number(v?.trim());
                        if (!Number.isInteger(n) || n < 1) return "Please enter a positive integer.";
                        if (n > remaining) return "Exceeds remaining capacity.";
                        return undefined;
                    },
                }),
            ) as string;
            const count = parseInt(countInput.trim(), 10) || 1;

            const existingIndex = roster.findIndex(
                (r) => r.role.toLowerCase() === roleName.toLowerCase(),
            );
            if (existingIndex >= 0) {
                roster[existingIndex] = {
                    ...roster[existingIndex],
                    description: description || roster[existingIndex].description,
                    count: roster[existingIndex].count + count,
                };
            } else {
                roster.push({ role: roleName, description: description || "Custom role.", count });
            }
            continue;
        }

        if (action === "edit") {
            if (roster.length === 0) {
                note("No roles to edit. Add a role first.", "Nothing to edit");
                continue;
            }

            const roleIdx = handleCancel(
                await select({
                    message: "Which role to edit?",
                    options: roster.map((r, idx) => ({
                        value: idx,
                        label: `${r.role} (${r.count} bots)`,
                    })),
                }),
            ) as number;

            const existing = roster[roleIdx];
            const newName = (handleCancel(
                await text({
                    message: `Edit role name (currently "${existing.role}")`,
                    initialValue: existing.role,
                    validate: (v) =>
                        (v ?? "").trim().length > 0 ? undefined : "Role name cannot be empty.",
                }),
            ) as string).trim();

            const newDesc = (handleCancel(
                await text({ message: "Edit description", initialValue: existing.description }),
            ) as string).trim();

            const newCountInput = handleCancel(
                await text({
                    message: `Edit bot count for "${newName}"`,
                    initialValue: String(existing.count),
                    validate: (v) => {
                        const n = Number(v?.trim());
                        if (!Number.isInteger(n) || n < 1) return "Please enter a positive integer.";
                        const hypothetical = currentAssigned - existing.count + n;
                        if (hypothetical > totalCapacity) return "Exceeds total team size.";
                        return undefined;
                    },
                }),
            ) as string;

            roster[roleIdx] = {
                role: newName,
                description: newDesc || existing.description,
                count: parseInt(newCountInput.trim(), 10) || existing.count,
            };
            continue;
        }

        if (action === "remove") {
            if (roster.length === 0) {
                note("No roles to remove.", "Nothing to remove");
                continue;
            }

            const roleIdx = handleCancel(
                await select({
                    message: "Which role to remove?",
                    options: roster.map((r, idx) => ({
                        value: idx,
                        label: `${r.role} (${r.count} bots)`,
                    })),
                }),
            ) as number;
            roster.splice(roleIdx, 1);
            continue;
        }
    }
}

// ---------------------------------------------------------------------------
// Persist all config
// ---------------------------------------------------------------------------

function persistAllConfig(state: WizardState): string {
    const wsUrl = `ws://${state.ip}:${state.port}`;
    const httpUrl = `http://${state.ip}:${state.apiPort}`;

    // 1. Global config (~/.teamclaw/config.json)
    const globalConfig: TeamClawGlobalConfig = {
        version: 1,
        managedGateway: state.managed,
        gatewayHost: state.ip,
        gatewayPort: Number(state.port),
        apiPort: state.apiPort,
        gatewayUrl: wsUrl,
        apiUrl: httpUrl,
        token: state.token,
        model: state.selectedModel || "gateway-default",
        chatEndpoint: "/v1/chat/completions",
        dashboardPort: 9001,
        debugMode: false,
        workspaceDir: state.workspaceDir,
    };
    const globalConfigPath = writeGlobalConfig(globalConfig);

    // 2. Project config (teamclaw.config.json)
    writeConfig({
        workerUrl: wsUrl,
        authToken: state.token,
        roster: state.roster,
        goal: state.goal,
        model: state.selectedModel,
        chatEndpoint: "/v1/chat/completions",
        workspaceDir: state.workspaceDir,
        templateId: state.templateId,
        projectName: state.projectName,
    });

    // 3. Runtime setters
    setOpenClawWorkerUrl(wsUrl);
    setOpenClawHttpUrl(httpUrl);
    if (state.selectedModel) setOpenClawModel(state.selectedModel);
    setOpenClawToken(state.token);
    setOpenClawChatEndpoint("/v1/chat/completions");

    return globalConfigPath;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
    const canTTY = Boolean(process.stdout.isTTY && process.stderr.isTTY);

    if (canTTY) {
        intro(pc.bold(pc.cyan("TeamClaw Setup Wizard")));
    } else {
        logger.info("TeamClaw Setup Wizard");
    }

    const state: WizardState = {
        ip: "127.0.0.1",
        port: "18789",
        token: "",
        apiPort: 18791,
        detectedModel: null,
        workspaceDir: path.resolve("./teamclaw-workspace"),
        projectName: "",
        selectedModel: "",
        goal: getDefaultGoal(),
        roster: [],
        templateId: "",
        managed: true,
    };

    // Step 1/6: Connection
    note("Step 1/6", pc.bold("Connection"));
    await stepConnection(state);

    // Step 2/6: Workspace
    note("Step 2/6", pc.bold("Workspace"));
    await stepWorkspace(state);

    // Step 3/6: Project
    note("Step 3/6", pc.bold("Project"));
    await stepProject(state);

    // Step 4/6: Model
    note("Step 4/6", pc.bold("Model Selection"));
    await stepModel(state);

    // Step 5/6: Goal
    note("Step 5/6", pc.bold("Goal"));
    await stepGoal(state);

    // Step 6/6: Team
    note("Step 6/6", pc.bold("Team"));
    await stepTeam(state);

    // Summary
    const rosterSummary = state.roster.length > 0
        ? state.roster.map((r) => `${r.count}x ${r.role}`).join(", ")
        : "(none)";

    const maxVal = 50;
    const trunc = (s: string) => {
        const flat = s.replace(/\n/g, " ").trim();
        return flat.length > maxVal ? flat.slice(0, maxVal - 3) + "..." : flat;
    };

    note(
        [
            `Gateway   : ${trunc(`ws://${state.ip}:${state.port}`)}`,
            `API URL   : ${trunc(`http://${state.ip}:${state.apiPort}`)}`,
            `Token     : ${state.token ? "configured" : "none"}`,
            `Workspace : ${trunc(state.workspaceDir)}`,
            `Project   : ${state.projectName || "(none)"}`,
            `Model     : ${trunc(state.selectedModel || "gateway-default")}`,
            `Goal      : ${trunc(state.goal)}`,
            `Team      : ${trunc(rosterSummary)}`,
            `Template  : ${state.templateId || "custom"}`,
        ].join("\n"),
        "Configuration Summary",
    );

    const saveConfirm = handleCancel(
        await confirm({
            message: "Save this configuration?",
            initialValue: true,
        }),
    ) as boolean;

    if (!saveConfirm) {
        cancel("Setup cancelled — nothing was saved.");
        process.exit(0);
    }

    const globalConfigPath = persistAllConfig(state);

    note(
        [
            `Global config : ${pc.cyan(globalConfigPath)}`,
            `Project config: ${pc.cyan("teamclaw.config.json")}`,
        ].join("\n"),
        "Config saved!",
    );

    // Final prompt
    const nextStep = handleCancel(
        await select({
            message: "What would you like to do next?",
            options: [
                { value: "work", label: "Start a work session now  (teamclaw work)" },
                { value: "exit", label: "Exit" },
            ],
        }),
    ) as string;

    if (nextStep === "work") {
        outro("Launching work session...");
        const { runWork } = await import("../work-runner.js");
        await runWork({ args: [], noWeb: false });
    } else {
        outro(
            `Setup complete! Run ${pc.green("teamclaw work")} whenever you're ready.`,
        );
    }
}
