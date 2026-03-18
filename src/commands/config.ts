import {
    cancel,
    confirm,
    intro,
    isCancel,
    note,
    outro,
    password,
    select,
    spinner,
    text,
} from "@clack/prompts";
import pc from "picocolors";
import { discoverOpenAIApi } from "../core/port-scanner.js";
import {
    readTeamclawConfig,
    writeTeamclawConfig,
} from "../core/jsonConfigManager.js";
import {
    readGlobalConfigWithDefaults,
    writeGlobalConfig,
    type TeamClawGlobalConfig,
} from "../core/global-config.js";
import { clearTeamConfigCache, loadTeamConfig } from "../core/team-config.js";
import { modelManagementMenu } from "./config/model-menu.js";
import { advancedSettingsMenu, type AdvancedState } from "./config/advanced-menu.js";
import { randomPhrase } from "../utils/spinner-phrases.js";

type MemoryBackend = "lancedb" | "local_json";
type LoggingLevel = "info" | "verbose";
type RosterEntry = { role: string; count: number; description: string };

interface DashboardState {
    gatewayUrl: string;
    token: string;
    model: string;
    chatEndpoint: string;
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
}

function maskSecret(value: string): string {
    const v = value.trim();
    if (!v) return "(not set)";
    if (v.length <= 8) return "********";
    return `${v.slice(0, 3)}…${v.slice(-4)}`;
}

function isHttpOrWsUrl(value: string): boolean {
    return /^(https?|wss?):\/\//i.test(value.trim());
}

function parsePort(value: string): number | null {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
}

function parsePortFromUrl(value: string): number | undefined {
    const input = value.trim();
    if (!input) return undefined;
    try {
        const withProtocol = input.includes("://") ? input : `http://${input}`;
        const parsed = new URL(withProtocol);
        if (!parsed.port) return undefined;
        const port = Number(parsed.port);
        return Number.isInteger(port) && port >= 1 && port <= 65535
            ? port
            : undefined;
    } catch {
        return undefined;
    }
}

async function fetchModelsForService(
    baseUrl: string,
    token: string,
): Promise<string[]> {
    const httpBase = /^wss?:\/\//i.test(baseUrl)
        ? baseUrl.replace(/^wss?:\/\//i, "http://")
        : baseUrl;
    const modelsUrl = `${httpBase.replace(/\/$/, "")}/v1/models`;
    try {
        const headers: Record<string, string> = {};
        if (token.trim().length > 0) {
            headers.Authorization = `Bearer ${token.trim()}`;
        }
        const res = await fetch(modelsUrl, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as {
            data?: Array<{ id?: string }>;
            models?: Array<{ id?: string; name?: string }>;
        };
        const fromData =
            data.data
                ?.map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
                .filter((x) => x.length > 0) ?? [];
        const fromModels =
            data.models
                ?.map((m) => {
                    const id = typeof m.id === "string" ? m.id.trim() : "";
                    const name =
                        typeof m.name === "string" ? m.name.trim() : "";
                    return id || name;
                })
                .filter((x) => x.length > 0) ?? [];
        return Array.from(new Set([...fromData, ...fromModels]));
    } catch {
        return [];
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function handleCancel<T>(v: T): T {
    if (isCancel(v)) {
        cancel("Configuration editor cancelled.");
        process.exit(0);
    }
    return v;
}

async function loadDashboardState(): Promise<DashboardState> {
    const globalCfg = readGlobalConfigWithDefaults();
    const parsed = await loadTeamConfig();
    const cfg = readTeamclawConfig();
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

    const gatewayUrl =
        String(globalCfg.gatewayUrl || "") ||
        (typeof data.worker_url === "string" ? data.worker_url.trim() : "") ||
        (parsed?.worker_url?.trim() ?? "");

    const chatEndpoint =
        String(globalCfg.chatEndpoint || "") ||
        (typeof data.chat_endpoint === "string" ? data.chat_endpoint.trim() : "") ||
        (parsed?.chat_endpoint?.trim() ?? "/v1/chat/completions");

    const model =
        String(globalCfg.model || "") ||
        (typeof data.model === "string" ? data.model.trim() : "") ||
        (parsed?.model?.trim() ?? "");

    const token = String(globalCfg.token || "") ||
        (typeof data.token === "string" ? data.token.trim() : "") ||
        "";

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

    return {
        gatewayUrl,
        token,
        model,
        chatEndpoint,
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
    };
}

async function providerMenu(state: DashboardState): Promise<void> {
    let back = false;
    while (!back) {
        const choice = handleCancel(
            await select({
                message: "LLM Provider Settings",
                options: [
                    {
                        value: "url",
                        label: `Edit LLM Gateway URL (Current: ${state.gatewayUrl || "(not set)"})`,
                    },
                    {
                        value: "token",
                        label: `Edit API Token (Current: ${maskSecret(state.token)})`,
                    },
                    {
                        value: "endpoint",
                        label: `Edit Chat Endpoint (Current: ${state.chatEndpoint || "(not set)"})`,
                    },
                    { value: "discover", label: "Run Auto-Discovery Scanner" },
                    { value: "back", label: "Back to Main Menu" },
                ],
            }),
        ) as "url" | "token" | "endpoint" | "discover" | "back";

        if (choice === "back") {
            back = true;
            continue;
        }

        if (choice === "url") {
            const value = handleCancel(
                await text({
                    message: "LLM Gateway URL",
                    initialValue:
                        state.gatewayUrl || "ws://localhost:18789",
                    placeholder: "ws://localhost:18789",
                    validate: (v) =>
                        isHttpOrWsUrl(v ?? "")
                            ? undefined
                            : "URL must start with http://, https://, ws://, or wss://",
                }),
            ) as string;
            state.gatewayUrl = value.trim();
            continue;
        }

        if (choice === "token") {
            const value = handleCancel(
                await password({
                    message: "API Token",
                    validate: (v) =>
                        (v ?? "").trim().length > 0
                            ? undefined
                            : "Token cannot be empty",
                }),
            ) as string;
            state.token = value.trim();
            continue;
        }

        if (choice === "endpoint") {
            const value = handleCancel(
                await text({
                    message: "Chat Endpoint",
                    initialValue:
                        state.chatEndpoint || "/v1/chat/completions",
                    placeholder: "/v1/chat/completions",
                    validate: (v) =>
                        (v ?? "").trim().startsWith("/")
                            ? undefined
                            : "Endpoint must start with '/'",
                }),
            ) as string;
            state.chatEndpoint = value.trim();
            continue;
        }

        if (choice === "discover") {
            const s = spinner();
            s.start(randomPhrase("scan"));

            // Scan local ports for OpenAI-compatible services
            const discovered = await discoverOpenAIApi("http://localhost", {
                preferredPort: parsePortFromUrl(state.gatewayUrl),
                timeoutMs: 1000,
            }).catch(() => []);
            if (discovered.length === 0) {
                s.stop("⚠️ Could not auto-detect API.");
                note(
                    [
                        "No OpenAI-compatible API responded on common ports.",
                        "Tip: configure providers via `teamclaw setup` instead.",
                        "Tip: ensure you are pointing to the API port, not the Web UI port.",
                    ].join("\n"),
                    "Discovery warning",
                );
                continue;
            }
            let selectedService = discovered[0]!;
            s.stop(`Found ${discovered.length} OpenAI-compatible service(s).`);
            const pickedService = handleCancel(
                await select({
                    message:
                        discovered.length > 1
                            ? "Select detected service:"
                            : "Detected service:",
                    options: discovered.map((d, idx) => {
                        const proto =
                            d.protocol === "ws"
                                ? pc.magenta("[WS]")
                                : pc.cyan("[HTTP]");
                        const modelSummary =
                            d.protocol === "ws"
                                ? pc.dim("(Models verified after auth)")
                                : `${d.models.length} model${d.models.length !== 1 ? "s" : ""} found`;
                        return {
                            value: String(idx),
                            label: `${proto} Port ${d.port} (${d.serviceName} - ${modelSummary})`,
                        };
                    }),
                    initialValue: "0",
                }),
            ) as string;
            const pickedIdx = Number(pickedService);
            if (
                Number.isInteger(pickedIdx) &&
                pickedIdx >= 0 &&
                pickedIdx < discovered.length
            ) {
                selectedService = discovered[pickedIdx]!;
            }

            state.gatewayUrl = selectedService.baseUrl;
            state.chatEndpoint = selectedService.chatEndpoint;

            if (selectedService.protocol === "ws") {
                const tokenValue = handleCancel(
                    await password({
                        message:
                            "Selected WebSocket gateway. Enter API token:",
                        validate: (v) =>
                            (v ?? "").trim().length > 0
                                ? undefined
                                : "Token cannot be empty",
                    }),
                ) as string;
                state.token = tokenValue.trim();
                const models = await fetchModelsForService(
                    selectedService.baseUrl,
                    state.token,
                );
                if (models.length > 0) {
                    const selectedModel = handleCancel(
                        await select({
                            message:
                                "Select model for selected WebSocket service:",
                            options: models.map((m) => ({
                                value: m,
                                label: m,
                            })),
                            initialValue: models[0],
                        }),
                    ) as string;
                    state.model = selectedModel.trim();
                } else {
                    const modelValue = handleCancel(
                        await text({
                            message:
                                "Could not auto-fetch models for this WS gateway. Enter model manually:",
                            initialValue: state.model || "",
                            placeholder: "qwen2.5-coder:7b",
                            validate: (v) =>
                                (v ?? "").trim().length > 0
                                    ? undefined
                                    : "Model cannot be empty",
                        }),
                    ) as string;
                    state.model = modelValue.trim();
                    note(
                        "Model list not returned by gateway on /v1/models. Saved manual model value.",
                        "WebSocket service selected",
                    );
                }
            } else if (selectedService.models.length > 0) {
                const selectedModel = handleCancel(
                    await select({
                        message: "Select model for selected HTTP service:",
                        options: selectedService.models.map((m) => ({
                            value: m,
                            label: m,
                        })),
                        initialValue: selectedService.models[0],
                    }),
                ) as string;
                state.model = selectedModel.trim();
            }
        }
    }
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
        state.gatewayUrl =
            refreshed.gatewayUrl || state.gatewayUrl;
        state.token = refreshed.token || state.token;
        state.model = refreshed.model || state.model;
        state.chatEndpoint =
            refreshed.chatEndpoint || state.chatEndpoint;
        note(
            "Reloaded configuration from onboarding.",
            "Roster builder completed",
        );
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

function applyRuntime(_state: DashboardState): void {
    // Runtime setters removed; config is now persisted to global config
    // and providers are configured via the provider system.
}

function saveState(state: DashboardState): void {
    // Update global config (connection + system prefs)
    const globalCfg = readGlobalConfigWithDefaults();
    writeGlobalConfig({
        ...globalCfg,
        gatewayUrl: state.gatewayUrl,
        token: state.token,
        chatEndpoint: state.chatEndpoint,
        model: state.model,
        dashboardPort: state.webPort,
        ...({
            webhookOnTaskComplete: state.webhookOnTaskComplete || undefined,
            webhookOnCycleEnd: state.webhookOnCycleEnd || undefined,
            webhookSecret: state.webhookSecret || undefined,
        }),
    } as unknown as TeamClawGlobalConfig);

    // Update project config (team + project-specific settings)
    const cfg = readTeamclawConfig();
    const next = {
        ...cfg.data,
        worker_url: state.gatewayUrl,
        chat_endpoint: state.chatEndpoint,
        model: state.model,
        memory_backend: state.memoryBackend,
        vector_store_path: state.memoryPath,
        verbose_logging: state.loggingLevel === "verbose",
        web_port: state.webPort,
        roster: state.roster,
        workers: state.workers,
        creativity: state.creativity,
        max_cycles: state.maxCycles,
    } as Record<string, unknown>;
    writeTeamclawConfig(cfg.path, next);
    clearTeamConfigCache();
    applyRuntime(state);
}

export async function runConfigDashboard(): Promise<void> {
    intro(pc.bold(pc.cyan("TeamClaw Configuration Dashboard")));
    const state = await loadDashboardState();

    let keepRunning = true;
    while (keepRunning) {
        const choice = handleCancel(
            await select({
                message: "Main Menu",
                options: [
                    { value: "providers", label: "🔌 LLM Provider Settings" },
                    { value: "models", label: "🧩 Model Management" },
                    { value: "memory", label: "🧠 Memory & Database" },
                    { value: "team", label: "🤖 Team Roster & Workers" },
                    { value: "advanced", label: "🔧 Advanced Settings" },
                    { value: "system", label: "⚙️ System Preferences" },
                    { value: "save", label: "💾 Save & Exit" },
                ],
            }),
        ) as "providers" | "models" | "memory" | "team" | "advanced" | "system" | "save";

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
                webhookOnTaskComplete: state.webhookOnTaskComplete,
                webhookOnCycleEnd: state.webhookOnCycleEnd,
                webhookSecret: state.webhookSecret,
            };
            await advancedSettingsMenu(advState);
            state.creativity = advState.creativity;
            state.maxCycles = advState.maxCycles;
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
