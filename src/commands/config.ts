import {
    confirm,
    intro,
    note,
    outro,
    select,
    text,
} from "@clack/prompts";
import pc from "picocolors";
import { clampSelectOptions } from "../utils/searchable-select.js";
import {
    readOpenpawlConfig,
    writeOpenpawlConfig,
} from "../core/jsonConfigManager.js";
import {
    readGlobalConfig,
    readGlobalConfigWithDefaults,
    writeGlobalConfig,
    type OpenPawlGlobalConfig,
    type ProviderConfigEntry,
} from "../core/global-config.js";
import { clearTeamConfigCache, loadTeamConfig } from "../core/team-config.js";
import { modelManagementMenu } from "./config/model-menu.js";
import { advancedSettingsMenu, type AdvancedState } from "./config/advanced-menu.js";
import { addProvider, listProviders } from "./providers.js";
import { maskApiKey } from "../core/errors.js";
import { handleCancel } from "../onboard/setup-flow.js";

type MemoryBackend = "lancedb" | "local_json";
type LoggingLevel = "info" | "verbose";
type TeamMode = "autonomous" | "manual";
type RosterEntry = { role: string; count: number; description: string };

interface DashboardState {
    model: string;
    streamingEnabled: boolean;
    memoryBackend: MemoryBackend;
    memoryPath: string;
    roster: RosterEntry[];
    workers: Record<string, string>;
    webPort: number;
    loggingLevel: LoggingLevel;
    creativity: number;
    maxCycles: number;
    webhookOnTaskComplete: string;
    webhookOnCycleEnd: string;
    webhookSecret: string;
    // Project settings
    projectName: string;
    goal: string;
    teamMode: TeamMode;
    templateId: string;
}

function parsePort(value: string): number | null {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

async function loadDashboardState(): Promise<DashboardState> {
    const globalCfg = readGlobalConfigWithDefaults();
    const parsed = await loadTeamConfig();
    const cfg = readOpenpawlConfig();
    const data = asRecord(cfg.data);

    const memoryBackendRaw =
        (typeof data.memory_backend === "string" ? data.memory_backend : "") ||
        (parsed?.memory_backend ?? "");
    const memoryBackend: MemoryBackend =
        memoryBackendRaw === "local_json" ? "local_json" : "lancedb";

    const webPort =
        (typeof data.web_port === "number" ? data.web_port : 0) ||
        (typeof globalCfg.dashboardPort === "number" ? globalCfg.dashboardPort : 0) ||
        8000;
    const verboseRaw = data.verbose_logging ?? true;
    const loggingLevel: LoggingLevel =
        (verboseRaw === true || verboseRaw === "true") ? "verbose" : "info";

    const model =
        String(globalCfg.model || "") ||
        (typeof data.model === "string" ? data.model.trim() : "") ||
        (parsed?.model?.trim() ?? "");

    const memoryPath =
        (typeof data.vector_store_path === "string" ? data.vector_store_path : "") ||
        "data/vector_store";

    const workers = parsed?.workers ?? {};
    const roster = parsed?.roster ?? [];

    const globalRaw = globalCfg as unknown as Record<string, unknown>;

    const creativityRaw = data.creativity ?? globalRaw.creativity;
    const creativity = typeof creativityRaw === "number" ? creativityRaw : 0.5;

    const maxCyclesRaw = data.max_cycles ?? globalRaw.maxCycles;
    const maxCycles = typeof maxCyclesRaw === "number" ? maxCyclesRaw : 10;

    const webhookOnTaskComplete =
        (typeof globalRaw.webhookOnTaskComplete === "string"
            ? (globalRaw.webhookOnTaskComplete as string).trim()
            : "") ||
        (typeof data.webhook_on_task_complete === "string" ? data.webhook_on_task_complete : "");

    const webhookOnCycleEnd =
        (typeof globalRaw.webhookOnCycleEnd === "string"
            ? (globalRaw.webhookOnCycleEnd as string).trim()
            : "") ||
        (typeof data.webhook_on_cycle_end === "string" ? data.webhook_on_cycle_end : "");

    const webhookSecret =
        (typeof globalRaw.webhookSecret === "string"
            ? (globalRaw.webhookSecret as string).trim()
            : "") ||
        (typeof data.webhook_secret === "string" ? data.webhook_secret : "");

    const projectName = typeof data.project_name === "string" ? data.project_name : "";
    const goal = typeof data.goal === "string" ? data.goal : "";
    const teamModeRaw = data.team_mode ?? parsed?.team_mode;
    const teamMode: TeamMode = teamModeRaw === "manual" ? "manual" : "autonomous";
    const templateId = typeof data.template === "string" ? data.template : "";

    return {
        model,
        streamingEnabled: globalCfg.streaming?.enabled !== false,
        memoryBackend,
        memoryPath,
        roster,
        workers,
        webPort,
        loggingLevel,
        creativity,
        maxCycles,
        webhookOnTaskComplete,
        webhookOnCycleEnd,
        webhookSecret,
        projectName,
        goal,
        teamMode,
        templateId,
    };
}

async function providerMenu(_state: DashboardState): Promise<void> {
    let back = false;
    while (!back) {
        const config = readGlobalConfigWithDefaults();
        const providers = config.providers ?? [];
        const providerCount = providers.length;

        const choice = handleCancel(
            await select({
                message: "LLM Provider Settings",
                options: [
                    {
                        value: "add",
                        label: "Add / edit provider",
                        hint: "same flow as setup wizard",
                    },
                    {
                        value: "view",
                        label: `View configured providers${providerCount > 0 ? ` (${providerCount})` : ""}`,
                    },
                    {
                        value: "remove",
                        label: "Remove a provider",
                    },
                    {
                        value: "order",
                        label: "Set provider chain order",
                    },
                    { value: "back", label: "Back to Main Menu" },
                ],
            }),
        ) as "add" | "view" | "remove" | "order" | "back";

        if (choice === "back") {
            back = true;
            continue;
        }

        if (choice === "add") {
            // Reuse the full provider add flow from `openpawl providers add`
            await addProvider([]);
            continue;
        }

        if (choice === "view") {
            await listProviders();
            continue;
        }

        if (choice === "remove") {
            await removeProviderMenu();
            continue;
        }

        if (choice === "order") {
            await reorderChainMenu();
            continue;
        }
    }
}

async function removeProviderMenu(): Promise<void> {
    const config = readGlobalConfigWithDefaults();
    const providers = config.providers ?? [];

    if (providers.length === 0) {
        note("No providers configured.", "Nothing to remove");
        return;
    }

    const options = providers.map((p, i) => ({
        value: String(i),
        label: `${p.name ?? p.type}${p.model ? pc.dim(` (${p.model})`) : ""}${p.apiKey ? "  " + pc.dim(maskApiKey(p.apiKey)) : ""}`,
    }));
    options.push({ value: "cancel", label: "Cancel" });

    const choice = handleCancel(
        await select({
            message: "Select provider to remove:",
            options: clampSelectOptions(options),
        }),
    ) as string;

    if (choice === "cancel") return;

    const idx = Number(choice);
    if (!Number.isInteger(idx) || idx < 0 || idx >= providers.length) return;

    if (providers.length === 1) {
        note("Can't remove the only provider in your chain.\nAdd another provider first.", "Error");
        return;
    }

    const target = providers[idx]!;
    const yes = handleCancel(
        await confirm({
            message: `Remove ${target.name ?? target.type}?`,
            initialValue: false,
        }),
    ) as boolean;

    if (!yes) return;

    providers.splice(idx, 1);
    config.providers = providers;
    writeGlobalConfig(config);
    note(`Removed ${target.name ?? target.type}.`, "Done");
}

async function reorderChainMenu(): Promise<void> {
    const config = readGlobalConfigWithDefaults();
    const providers = config.providers ?? [];

    if (providers.length < 2) {
        note(
            providers.length === 0
                ? "No providers configured."
                : "Only one provider — nothing to reorder.",
            "Chain order",
        );
        return;
    }

    const currentOrder = providers.map((p) => p.name ?? p.type).join(" -> ");
    const ids = providers.map((p) => p.name ?? p.type);

    const newOrder = handleCancel(
        await text({
            message: "Enter provider IDs in priority order (comma-separated):",
            initialValue: ids.join(", "),
            placeholder: ids.join(", "),
            validate: (v) => {
                const entered = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
                if (entered.length === 0) return "Enter at least one provider";
                const unknown = entered.filter((e) => !ids.includes(e));
                if (unknown.length > 0) return `Unknown: ${unknown.join(", ")}. Available: ${ids.join(", ")}`;
                return undefined;
            },
        }),
    ) as string;

    const ordered = newOrder.split(",").map((s) => s.trim()).filter(Boolean);
    const reordered: ProviderConfigEntry[] = [];

    for (const id of ordered) {
        const found = providers.find((p) => (p.name ?? p.type) === id);
        if (found) reordered.push(found);
    }
    // Append any providers not mentioned (keep them at the end)
    for (const p of providers) {
        if (!reordered.includes(p)) reordered.push(p);
    }

    config.providers = reordered;
    writeGlobalConfig(config);
    const newOrderStr = reordered.map((p) => p.name ?? p.type).join(" -> ");
    note(`${currentOrder}\n  =>\n${newOrderStr}`, "Chain reordered");
}

async function memoryMenu(state: DashboardState): Promise<void> {
    let back = false;
    while (!back) {
        const choice = handleCancel(
            await select({
                message: "Memory & Database",
                options: [
                    {
                        value: "backend",
                        label: `Edit Memory Backend (Current: ${state.memoryBackend})`,
                    },
                    {
                        value: "path",
                        label: `Edit Memory Path (Current: ${state.memoryPath})`,
                    },
                    { value: "back", label: "Back to Main Menu" },
                ],
            }),
        ) as "backend" | "path" | "back";

        if (choice === "back") {
            back = true;
            continue;
        }
        if (choice === "backend") {
            const selected = handleCancel(
                await select({
                    message: "Select memory backend",
                    initialValue: state.memoryBackend,
                    options: [
                        { value: "lancedb", label: "LanceDB" },
                        { value: "local_json", label: "Local JSON" },
                    ],
                }),
            ) as MemoryBackend;
            state.memoryBackend = selected;
            continue;
        }
        if (choice === "path") {
            const value = handleCancel(
                await text({
                    message: "Memory database path",
                    initialValue: state.memoryPath,
                    placeholder: "data/vector_store",
                    validate: (v) =>
                        (v ?? "").trim().length > 0
                            ? undefined
                            : "Path cannot be empty",
                }),
            ) as string;
            state.memoryPath = value.trim();
        }
    }
}

function rosterSummary(state: DashboardState): string {
    if (state.roster.length === 0) return "(No roles configured)";
    return state.roster
        .map(
            (r) =>
                `${r.count}x ${r.role}${r.description ? ` — ${r.description}` : ""}`,
        )
        .join("\n");
}

async function teamMenu(state: DashboardState): Promise<void> {
    let back = false;
    while (!back) {
        const choice = handleCancel(
            await select({
                message: "Team Roster & Workers",
                options: [
                    { value: "view", label: "View current roles" },
                    {
                        value: "onboard",
                        label: "Launch Roster Builder (Onboarding Wizard)",
                    },
                    { value: "back", label: "Back to Main Menu" },
                ],
            }),
        ) as "view" | "onboard" | "back";

        if (choice === "back") {
            back = true;
            continue;
        }
        if (choice === "view") {
            note(rosterSummary(state), "Current roster");
            continue;
        }
        const run = handleCancel(
            await confirm({
                message: "Open onboarding roster builder now?",
                initialValue: true,
            }),
        ) as boolean;
        if (!run) continue;
        const { runOnboard } = await import("../onboard/index.js");
        await runOnboard();
        const refreshed = await loadDashboardState();
        state.roster = refreshed.roster;
        state.workers = refreshed.workers;
        state.model = refreshed.model || state.model;
        note(
            "Reloaded configuration from onboarding.",
            "Roster builder completed",
        );
    }
}

async function projectMenu(state: DashboardState): Promise<void> {
    let back = false;
    while (!back) {
        const truncGoal = state.goal.length > 50 ? state.goal.slice(0, 47) + "..." : state.goal;
        const choice = handleCancel(
            await select({
                message: "Project Settings",
                options: clampSelectOptions([
                    {
                        value: "project",
                        label: `Project Name`,
                        hint: state.projectName || "not set",
                    },
                    {
                        value: "goal",
                        label: `Goal`,
                        hint: truncGoal || "not set",
                    },
                    {
                        value: "teammode",
                        label: `Team Mode`,
                        hint: state.teamMode,
                    },
                    {
                        value: "template",
                        label: `Template`,
                        hint: state.templateId || "none",
                    },
                    { value: "back", label: "Back to Main Menu" },
                ]),
            }),
        ) as "project" | "goal" | "teammode" | "template" | "back";

        if (choice === "back") {
            back = true;
            continue;
        }
        if (choice === "project") {
            const raw = handleCancel(
                await text({
                    message: "Project name",
                    initialValue: state.projectName,
                    placeholder: "my-project",
                }),
            ) as string;
            state.projectName = raw.trim() || state.projectName;
            continue;
        }
        if (choice === "goal") {
            const raw = handleCancel(
                await text({
                    message: "What does your team need to build?",
                    initialValue: state.goal,
                    placeholder: "Describe your goal",
                }),
            ) as string;
            state.goal = raw.trim() || state.goal;
            continue;
        }
        if (choice === "teammode") {
            const selected = handleCancel(
                await select({
                    message: "Team mode",
                    initialValue: state.teamMode,
                    options: [
                        { value: "autonomous", label: "Autonomous", hint: "Coordinator picks agents for each task" },
                        { value: "manual", label: "Manual", hint: "Use roster as-is" },
                    ],
                }),
            ) as TeamMode;
            state.teamMode = selected;
            continue;
        }
        if (choice === "template") {
            const raw = handleCancel(
                await text({
                    message: "Template ID (e.g. fullstack, dev_team, or leave empty for custom)",
                    initialValue: state.templateId,
                    placeholder: "template-id",
                }),
            ) as string;
            state.templateId = raw.trim();
            continue;
        }
    }
}

async function systemMenu(state: DashboardState): Promise<void> {
    let back = false;
    while (!back) {
        const choice = handleCancel(
            await select({
                message: "System Preferences",
                options: [
                    {
                        value: "port",
                        label: `Edit Default Web UI Port (Current: ${state.webPort})`,
                    },
                    {
                        value: "logging",
                        label: `Edit Logging Level (Current: ${state.loggingLevel})`,
                    },
                    { value: "back", label: "Back to Main Menu" },
                ],
            }),
        ) as "port" | "logging" | "back";

        if (choice === "back") {
            back = true;
            continue;
        }
        if (choice === "port") {
            const raw = handleCancel(
                await text({
                    message: "Default Web UI Port",
                    initialValue: String(state.webPort),
                    placeholder: "8000",
                    validate: (v) =>
                        parsePort(v ?? "") != null
                            ? undefined
                            : "Port must be an integer 1-65535",
                }),
            ) as string;
            state.webPort = parsePort(raw.trim()) ?? state.webPort;
            continue;
        }
        const selected = handleCancel(
            await select({
                message: "Logging level",
                initialValue: state.loggingLevel,
                options: [
                    { value: "info", label: "Info" },
                    { value: "verbose", label: "Verbose" },
                ],
            }),
        ) as LoggingLevel;
        state.loggingLevel = selected;
    }
}

function saveState(state: DashboardState): void {
    // Update global config (system prefs — providers managed separately)
    const globalCfg = readGlobalConfigWithDefaults();
    writeGlobalConfig({
        ...globalCfg,
        model: state.model,
        dashboardPort: state.webPort,
        streaming: { enabled: state.streamingEnabled, showThinking: globalCfg.streaming?.showThinking ?? false },
        ...({
            webhookOnTaskComplete: state.webhookOnTaskComplete || undefined,
            webhookOnCycleEnd: state.webhookOnCycleEnd || undefined,
            webhookSecret: state.webhookSecret || undefined,
        }),
    } as unknown as OpenPawlGlobalConfig);

    // Update project config (team + project-specific settings)
    const cfg = readOpenpawlConfig();
    const next = {
        ...cfg.data,
        model: state.model,
        memory_backend: state.memoryBackend,
        vector_store_path: state.memoryPath,
        verbose_logging: state.loggingLevel === "verbose",
        web_port: state.webPort,
        roster: state.roster,
        workers: state.workers,
        creativity: state.creativity,
        max_cycles: state.maxCycles,
        project_name: state.projectName || undefined,
        goal: state.goal || undefined,
        team_mode: state.teamMode,
        template: state.templateId || undefined,
    } as Record<string, unknown>;
    writeOpenpawlConfig(cfg.path, next);
    clearTeamConfigCache();
}

export async function runConfigDashboard(): Promise<void> {
    const existingConfig = readGlobalConfig();

    if (!existingConfig) {
        intro(pc.bold(pc.cyan("OpenPawl Configuration")));
        note(
            `No configuration found.\nRun ${pc.bold("openpawl setup")} first to configure providers,\nworkspace, and team — then use ${pc.bold("openpawl config")} to fine-tune.`,
            "Setup required",
        );

        const shouldSetup = handleCancel(
            await confirm({
                message: "Would you like to run setup now?",
                initialValue: true,
            }),
        );

        if (shouldSetup) {
            const { runSetup } = await import("../onboard/setup-flow.js");
            await runSetup();
        } else {
            outro("Run " + pc.bold("openpawl setup") + " when you're ready.");
        }
        return;
    }

    intro(pc.bold(pc.cyan("OpenPawl Configuration Dashboard")));
    const state = await loadDashboardState();

    let keepRunning = true;
    while (keepRunning) {
        const choice = handleCancel(
            await select({
                message: "Main Menu",
                options: clampSelectOptions([
                    { value: "project", label: "📁 Project Settings" },
                    { value: "providers", label: "🔌 LLM Provider Settings" },
                    { value: "models", label: "🧩 Model Management" },
                    { value: "memory", label: "🧠 Memory & Database" },
                    { value: "team", label: "🤖 Team Roster & Workers" },
                    { value: "advanced", label: "🔧 Advanced Settings" },
                    { value: "system", label: "\u{2699}\uFE0F  System Preferences" },
                    { value: "save", label: "💾 Save & Exit" },
                ]),
            }),
        ) as "project" | "providers" | "models" | "memory" | "team" | "advanced" | "system" | "save";

        if (choice === "project") {
            await projectMenu(state);
            continue;
        }
        if (choice === "providers") {
            await providerMenu(state);
            continue;
        }
        if (choice === "models") {
            await modelManagementMenu();
            // Refresh state from disk — model menu persists changes directly
            const refreshedCfg = readGlobalConfigWithDefaults();
            state.model = String(refreshedCfg.model || "") || state.model;
            continue;
        }
        if (choice === "memory") {
            await memoryMenu(state);
            continue;
        }
        if (choice === "team") {
            await teamMenu(state);
            continue;
        }
        if (choice === "advanced") {
            const advState: AdvancedState = {
                creativity: state.creativity,
                maxCycles: state.maxCycles,
                streamingEnabled: state.streamingEnabled,
                webhookOnTaskComplete: state.webhookOnTaskComplete,
                webhookOnCycleEnd: state.webhookOnCycleEnd,
                webhookSecret: state.webhookSecret,
            };
            await advancedSettingsMenu(advState);
            state.creativity = advState.creativity;
            state.maxCycles = advState.maxCycles;
            state.streamingEnabled = advState.streamingEnabled;
            state.webhookOnTaskComplete = advState.webhookOnTaskComplete;
            state.webhookOnCycleEnd = advState.webhookOnCycleEnd;
            state.webhookSecret = advState.webhookSecret;
            continue;
        }
        if (choice === "system") {
            await systemMenu(state);
            continue;
        }

        const doSave = handleCancel(
            await confirm({
                message: "Save changes and exit?",
                initialValue: true,
            }),
        ) as boolean;
        if (!doSave) continue;
        saveState(state);
        note("Configuration saved successfully!", "Success");
        keepRunning = false;
    }

    outro("Configuration dashboard closed.");
    process.exit(0);
}
