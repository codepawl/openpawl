/**
 * Global configuration for TeamClaw.
 * Loads from Global JSON (~/.teamclaw/config.json) and Workspace JSON (teamclaw.config.json).
 * Priority: CLI Flags → Global JSON → Workspace JSON → Defaults.
 */

import {
    cancel,
    isCancel,
    note,
    password,
    select,
    spinner,
    text,
} from "@clack/prompts";
import pc from "picocolors";
import type { TeamConfig } from "./team-config.js";
import { clearTeamConfigCache, loadTeamConfig } from "./team-config.js";
import {
    readTeamclawConfig,
    writeTeamclawConfig,
} from "./jsonConfigManager.js";
import { discoverOpenAIApi, readLocalOpenClawConfig } from "./discovery.js";
import { readGlobalConfigWithDefaults } from "./global-config.js";
import { migrateEnvToGlobalJson } from "./configMigrator.js";
import { setConfigAgentModels } from "./model-config.js";

migrateEnvToGlobalJson();

export type MemoryBackend = "lancedb" | "local_json";

function loadGlobalConfig() {
    return readGlobalConfigWithDefaults();
}

const globalCfg = loadGlobalConfig() as unknown as Record<string, unknown>;

// Feed per-agent models from global config into the model resolution layer
const _globalAgentModels = globalCfg.agentModels;
if (_globalAgentModels && typeof _globalAgentModels === "object" && !Array.isArray(_globalAgentModels)) {
    setConfigAgentModels(_globalAgentModels as Record<string, string>);
}

function getGlobalString(key: string, defaultVal: string): string {
    const val = globalCfg[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    return defaultVal;
}

function getGlobalNumber(key: string, defaultVal: number): number {
    const val = globalCfg[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string") {
        const n = Number(val);
        if (Number.isFinite(n)) return n;
    }
    return defaultVal;
}

function getGlobalBoolean(key: string, defaultVal: boolean): boolean {
    const val = globalCfg[key];
    if (typeof val === "boolean") return val;
    return defaultVal;
}

export const CONFIG = {
    llmTemperature: getGlobalNumber("llmTemperature", 0.7),
    creativity: getGlobalNumber("creativity", 0.5),
    llmTimeoutMs: getGlobalNumber("llmTimeoutMs", 120_000),

    maxCycles: getGlobalNumber("maxCycles", 10),
    maxRuns: getGlobalNumber("maxRuns", 5),

    workspaceDir: getGlobalString("workspaceDir", "./teamclaw-workspace"),

    vectorStorePath: getGlobalString("vectorStorePath", "data/vector_store"),
    memoryBackend: (getGlobalString("memoryBackend", "lancedb") as MemoryBackend),
    verboseLogging: getGlobalBoolean("verboseLogging", false),
    debugMode: getGlobalBoolean("debugMode", false),

    openclawWorkerUrl: String(globalCfg.gatewayUrl || ""),
    openclawHttpUrl: String(globalCfg.apiUrl || ""),
    openclawWorkers: {} as Record<string, string>,
    openclawToken: String(globalCfg.token || ""),
    openclawChatEndpoint: String(globalCfg.chatEndpoint || "/v1/chat/completions"),
    openclawModel: String(globalCfg.model || ""),
    openclawProvisionTimeout: getGlobalNumber("openclawProvisionTimeout", 30_000),

    webhookOnTaskComplete: getGlobalString("webhookOnTaskComplete", ""),
    webhookOnCycleEnd: getGlobalString("webhookOnCycleEnd", ""),
    webhookSecret: getGlobalString("webhookSecret", ""),
} as const;

type MutableOpenClawRuntimeConfig = {
    openclawWorkerUrl: string;
    openclawHttpUrl: string;
    openclawToken: string;
    openclawChatEndpoint: string;
    openclawModel: string;
};

function applyRuntimeOpenClawConfig(
    update: Partial<MutableOpenClawRuntimeConfig>,
): void {
    const cfg = CONFIG as unknown as MutableOpenClawRuntimeConfig;
    if (typeof update.openclawWorkerUrl === "string") {
        process.env["OPENCLAW_WORKER_URL"] = update.openclawWorkerUrl;
        cfg.openclawWorkerUrl = update.openclawWorkerUrl;
    }
    if (typeof update.openclawHttpUrl === "string") {
        process.env["OPENCLAW_HTTP_URL"] = update.openclawHttpUrl;
        cfg.openclawHttpUrl = update.openclawHttpUrl;
    }
    if (typeof update.openclawToken === "string") {
        process.env["OPENCLAW_TOKEN"] = update.openclawToken;
        cfg.openclawToken = update.openclawToken;
    }
    if (typeof update.openclawChatEndpoint === "string") {
        process.env["OPENCLAW_CHAT_ENDPOINT"] = update.openclawChatEndpoint;
        cfg.openclawChatEndpoint = update.openclawChatEndpoint;
    }
    if (typeof update.openclawModel === "string") {
        process.env["OPENCLAW_MODEL"] = update.openclawModel;
        cfg.openclawModel = update.openclawModel;
    }
}

export interface SessionConfig {
    creativity?: number;
    max_cycles?: number;
    max_generations?: number;
    worker_url?: string;
    user_goal?: string;
    team_template?: string;
    approval_keywords?: string[];
    gateway_url?: string;
    team_model?: string;
}

const DEFAULT_APPROVAL_KEYWORDS = [
    "deploy",
    "release",
    "production",
    "critical",
];

let sessionOverrides: Partial<SessionConfig> = {};

export function setSessionConfig(overrides: Partial<SessionConfig>): void {
    sessionOverrides = { ...overrides };
}

export function getApprovalKeywords(): string[] {
    return sessionOverrides.approval_keywords ?? DEFAULT_APPROVAL_KEYWORDS;
}

export function getSessionCreativity(): number {
    return sessionOverrides.creativity ?? CONFIG.creativity;
}

export function clearSessionConfig(): void {
    sessionOverrides = {};
}

/** Directly update the runtime HTTP API URL used by the LLM adapter. */
export function setOpenClawHttpUrl(url: string): void {
    applyRuntimeOpenClawConfig({ openclawHttpUrl: url });
}

/** Directly update the runtime model used by the LLM adapter. */
export function setOpenClawModel(model: string): void {
    applyRuntimeOpenClawConfig({ openclawModel: model });
}

/** Directly update the runtime token used by the LLM adapter. */
export function setOpenClawToken(token: string): void {
    applyRuntimeOpenClawConfig({ openclawToken: token });
}

/** Directly update the runtime chat endpoint used by the LLM adapter. */
export function setOpenClawChatEndpoint(endpoint: string): void {
    applyRuntimeOpenClawConfig({ openclawChatEndpoint: endpoint });
}

/** Update the runtime WebSocket gateway URL (e.g. after the user selects a port interactively). */
export function setOpenClawWorkerUrl(url: string): void {
    applyRuntimeOpenClawConfig({ openclawWorkerUrl: url });
}

function creativityToTemperature(creativity: number): number {
    return Math.max(0.2, Math.min(1.5, 0.3 + creativity * 0.9));
}

export function getSessionTemperature(): number {
    return creativityToTemperature(getSessionCreativity());
}

export function getGatewayUrl(): string {
    return sessionOverrides.gateway_url?.trim() ?? "";
}

export function getTeamModel(): string {
    return sessionOverrides.team_model?.trim() ?? "team-default";
}

export function getWorkspaceDir(): string {
    return CONFIG.workspaceDir;
}

export function getWorkerUrlsForTeam(
    botIds: string[],
    overrides?: { singleUrl?: string; workers?: Record<string, string> },
): Record<string, string> {
    if (overrides?.workers && Object.keys(overrides.workers).length > 0) {
        return overrides.workers;
    }
    const single =
        overrides?.singleUrl?.trim() ?? CONFIG.openclawWorkerUrl?.trim();
    if (single) {
        const out: Record<string, string> = {};
        for (const id of botIds) out[id] = single;
        return out;
    }
    if (Object.keys(CONFIG.openclawWorkers).length > 0)
        return CONFIG.openclawWorkers;
    return {};
}

function hasValidRoster(cfg: TeamConfig | null): boolean {
    const roster = cfg?.roster;
    if (!roster || roster.length === 0) return false;
    return roster.some(
        (r) =>
            r &&
            typeof r.role === "string" &&
            r.role.trim().length > 0 &&
            Number.isFinite(r.count) &&
            (r.count as number) >= 1,
    );
}

function handleInlineCancel<T>(v: T): T {
    if (isCancel(v)) {
        cancel("Setup cancelled.");
        throw new Error("Inline configuration cancelled by user");
    }
    return v;
}

function parsePortFromUrl(url: string): number | undefined {
    try {
        const withProtocol = url.includes("://") ? url : `http://${url}`;
        const parsed = new URL(withProtocol);
        if (!parsed.port) return undefined;
        const n = Number(parsed.port);
        return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
    } catch {
        return undefined;
    }
}

async function discoverOpenClawModel(
    workerUrl: string,
    token: string,
): Promise<string | null> {
    const base = workerUrl.replace(/\/$/, "");
    const modelsUrl = `${/\/v1$/i.test(base) ? base : `${base}/v1`}/models`;
    try {
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(modelsUrl, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
            data?: Array<{ id?: string }>;
            models?: Array<{ id?: string; name?: string }>;
            model?: string;
        };
        const firstDataModel = data.data?.find(
            (m) => typeof m.id === "string" && m.id.trim().length > 0,
        )?.id;
        if (firstDataModel) return firstDataModel.trim();
        const firstModelsModel =
            data.models?.find(
                (m) => typeof m.id === "string" || typeof m.name === "string",
            ) ?? null;
        if (firstModelsModel?.id && firstModelsModel.id.trim().length > 0)
            return firstModelsModel.id.trim();
        if (firstModelsModel?.name && firstModelsModel.name.trim().length > 0)
            return firstModelsModel.name.trim();
        if (typeof data.model === "string" && data.model.trim().length > 0)
            return data.model.trim();
        return null;
    } catch {
        return null;
    }
}

export async function validateOrPromptConfig(
    opts: { forceDiscover?: boolean } = {},
): Promise<void> {
    // Fast path: if everything already looks good, return immediately.
    const teamCfg = await loadTeamConfig();
    const rosterOk = hasValidRoster(teamCfg);

    // Wire per-agent models from team config into model resolution layer
    if (teamCfg?.agent_models && Object.keys(teamCfg.agent_models).length > 0) {
        setConfigAgentModels(teamCfg.agent_models);
    }

    // Read values from global JSON config + project JSON config (no .env)
    const openclawUrl = CONFIG.openclawWorkerUrl ||
        (teamCfg?.worker_url ?? "").trim();
    const openclawToken =
        CONFIG.openclawToken ||
        (teamCfg?.openclaw_token ?? "").trim();
    const openclawChatEndpoint =
        CONFIG.openclawChatEndpoint ||
        (teamCfg?.openclaw_chat_endpoint ?? "").trim();
    const openclawModel =
        CONFIG.openclawModel ||
        (teamCfg?.openclaw_model ?? "").trim() ||
        "gateway-default";

    let effectiveOpenclawUrl = openclawUrl;
    let effectiveOpenclawToken = openclawToken;
    let effectiveOpenclawChatEndpoint = openclawChatEndpoint;
    let effectiveOpenclawModel = openclawModel;
    let discoveredModels: string[] = [];
    // Track whether local config has auth disabled — used to skip token prompt
    let localConfigAuthNotRequired = false;
    // Track whether values were filled/changed by discovery so we can persist
    let configDirty = false;

    // Eagerly fill any missing effective values from the local OpenClaw config
    // file BEFORE the fast-path check.
    if (
        !effectiveOpenclawUrl ||
        !effectiveOpenclawToken ||
        !effectiveOpenclawChatEndpoint ||
        !effectiveOpenclawModel
    ) {
        const earlyLocalCfg = opts.forceDiscover
            ? null
            : readLocalOpenClawConfig();
        if (earlyLocalCfg) {
            if (!earlyLocalCfg.authRequired) {
                localConfigAuthNotRequired = true;
            }
            if (!effectiveOpenclawUrl) {
                effectiveOpenclawUrl = earlyLocalCfg.url;
                configDirty = true;
            }
            applyRuntimeOpenClawConfig({ openclawHttpUrl: earlyLocalCfg.httpUrl });
            if (!effectiveOpenclawToken) {
                effectiveOpenclawToken = earlyLocalCfg.token;
                configDirty = true;
            }
            if (!effectiveOpenclawChatEndpoint) {
                effectiveOpenclawChatEndpoint = "/v1/chat/completions";
                configDirty = true;
            }
            if (earlyLocalCfg.model) {
                effectiveOpenclawModel = earlyLocalCfg.model;
                configDirty = true;
            }
        }
    }

    if (
        rosterOk &&
        effectiveOpenclawUrl &&
        effectiveOpenclawToken &&
        effectiveOpenclawChatEndpoint &&
        effectiveOpenclawModel
    ) {
        applyRuntimeOpenClawConfig({
            openclawWorkerUrl: effectiveOpenclawUrl,
            openclawToken: effectiveOpenclawToken,
            openclawChatEndpoint: effectiveOpenclawChatEndpoint,
            openclawModel: effectiveOpenclawModel,
        });
        if (configDirty) {
            persistToProjectConfig(effectiveOpenclawUrl, effectiveOpenclawChatEndpoint, effectiveOpenclawModel);
        }
        return;
    }

    // Detect whether teamclaw.config.json exists / has content.
    const tc = readTeamclawConfig();
    const configEmpty = Object.keys(tc.data).length === 0;

    // If there is no project config at all yet, run the full onboarding wizard.
    if (
        configEmpty &&
        !openclawUrl &&
        !openclawToken &&
        !openclawChatEndpoint &&
        !openclawModel &&
        !rosterOk
    ) {
        note(
            "Welcome! Let's do a quick 10-second setup before we start working.",
            "TeamClaw setup",
        );
        const { runSetup } = await import("../commands/setup.js");
        await runSetup();
        clearTeamConfigCache();
        return;
    }

    // Otherwise, prompt only for missing scalar values here; leave rich roster
    // editing to the dedicated onboard flow if it's still missing.

    // Run Discovery only when the gateway URL itself is unknown, or the user
    // explicitly requested a re-scan via --discover.
    if (!effectiveOpenclawUrl || opts.forceDiscover) {
        const s = spinner();
        s.start("🔍 Checking for local OpenClaw configuration...");

        const localCfg = opts.forceDiscover ? null : readLocalOpenClawConfig();

        if (localCfg) {
            if (!localCfg.authRequired) {
                localConfigAuthNotRequired = true;
            }
            effectiveOpenclawUrl = localCfg.url;
            effectiveOpenclawToken = localCfg.token;
            if (localCfg.model && !effectiveOpenclawModel) {
                effectiveOpenclawModel = localCfg.model;
            }
            if (!effectiveOpenclawChatEndpoint) {
                effectiveOpenclawChatEndpoint = "/v1/chat/completions";
            }

            applyRuntimeOpenClawConfig({
                openclawWorkerUrl: effectiveOpenclawUrl,
                openclawHttpUrl: localCfg.httpUrl,
                openclawToken: effectiveOpenclawToken,
                openclawChatEndpoint: effectiveOpenclawChatEndpoint,
                openclawModel: effectiveOpenclawModel,
            });

            const modelLabel = localCfg.model
                ? `, model: ${localCfg.model}`
                : "";
            s.stop(
                `✅ [Config File] Found OpenClaw configuration! (Port: ${localCfg.port}${modelLabel})`,
            );
        } else {
            // No local config file — fall back to the network port scanner.
            s.start("📡 Scanning local network for OpenClaw API...");
            const discovered = await discoverOpenAIApi("http://localhost", {
                preferredPort: parsePortFromUrl(effectiveOpenclawUrl),
                timeoutMs: 1000,
            });
            if (discovered.length > 0) {
                let selected = discovered[0]!;
                if (discovered.length > 1) {
                    s.stop(
                        `📡 Found ${discovered.length} OpenAI-compatible service(s).`,
                    );
                    const pickedPort = handleInlineCancel(
                        await select({
                            message:
                                "Select detected OpenAI-compatible service:",
                            options: discovered.map((d, idx) => {
                                const modelHint =
                                    d.protocol === "ws"
                                        ? pc.dim("(Models verified after auth)")
                                        : `${d.models.length} model${d.models.length !== 1 ? "s" : ""}`;
                                return {
                                    value: String(idx),
                                    label: `Port ${d.port} [${d.protocol.toUpperCase()}] ${d.serviceName} — ${modelHint}`,
                                };
                            }),
                            initialValue: "0",
                        }),
                    ) as string;
                    const parsedIdx = Number(pickedPort);
                    selected =
                        Number.isInteger(parsedIdx) &&
                        parsedIdx >= 0 &&
                        parsedIdx < discovered.length
                            ? discovered[parsedIdx]!
                            : selected;
                } else {
                    s.stop(
                        `✅ Found ${selected.serviceName} at port ${selected.port} (${selected.protocol.toUpperCase()})`,
                    );
                }
                discoveredModels =
                    selected.protocol === "http" ? selected.models : [];
                if (!effectiveOpenclawUrl || opts.forceDiscover) {
                    effectiveOpenclawUrl = selected.baseUrl;
                    applyRuntimeOpenClawConfig({
                        openclawWorkerUrl: effectiveOpenclawUrl,
                    });
                }
                if (
                    !effectiveOpenclawChatEndpoint &&
                    selected.protocol === "http"
                ) {
                    effectiveOpenclawChatEndpoint = selected.chatEndpoint;
                    applyRuntimeOpenClawConfig({
                        openclawChatEndpoint: effectiveOpenclawChatEndpoint,
                    });
                }
            } else {
                s.stop("⚠️ Could not auto-detect API.");
                note(
                    [
                        "Ensure you are pointing to the API port, not the Web UI port.",
                        "For many setups, 8001 is a Web UI while API lives on another port.",
                    ].join("\n"),
                    "OpenClaw auto-discovery",
                );
            }
        }
    }

    // From here on, gate every prompt on the *effective* value so that anything
    // filled by the local config file or the network scanner is never re-asked.
    if (!effectiveOpenclawUrl) {
        const url = handleInlineCancel(
            await text({
                message:
                    "Missing OpenClaw Gateway URL. Please enter it:",
                placeholder: "http://localhost:8001",
                validate: (v) =>
                    (v ?? "").trim().length > 0
                        ? undefined
                        : "URL cannot be empty",
            }),
        ) as string;
        const value = url.trim();
        if (value) {
            effectiveOpenclawUrl = value;
            applyRuntimeOpenClawConfig({ openclawWorkerUrl: value });
        }
    }

    // Skip token prompt if auth is disabled in local config
    if (!effectiveOpenclawToken && !localConfigAuthNotRequired) {
        const token = handleInlineCancel(
            await password({
                message:
                    "Missing OpenClaw token. Please enter it:",
                validate: (v) =>
                    (v ?? "").trim().length > 0
                        ? undefined
                        : "Token cannot be empty",
            }),
        ) as string;
        const value = token.trim();
        if (value) {
            effectiveOpenclawToken = value;
            applyRuntimeOpenClawConfig({ openclawToken: value });
        }
    }

    if (!effectiveOpenclawChatEndpoint) {
        const endpoint = handleInlineCancel(
            await text({
                message:
                    "Missing OpenClaw chat endpoint. Please enter it:",
                initialValue: "/v1/chat/completions",
                placeholder: "/v1/chat/completions",
                validate: (v) =>
                    (v ?? "").trim().length > 0
                        ? undefined
                        : "Endpoint cannot be empty",
            }),
        ) as string;
        const value = endpoint.trim();
        if (value) {
            effectiveOpenclawChatEndpoint = value;
            applyRuntimeOpenClawConfig({ openclawChatEndpoint: value });
        }
    }

    if (!effectiveOpenclawModel) {
        const discovered = discoveredModels.length > 0
            ? discoveredModels[0] ?? null
            : effectiveOpenclawUrl
                ? await discoverOpenClawModel(
                      effectiveOpenclawUrl,
                      effectiveOpenclawToken,
                  )
                : null;
        const value = (discovered ?? "gateway-default").trim();
        effectiveOpenclawModel = value;
        applyRuntimeOpenClawConfig({ openclawModel: value });
    }

    // Ensure all resolved values are immediately available in this process.
    applyRuntimeOpenClawConfig({
        openclawWorkerUrl: effectiveOpenclawUrl,
        openclawToken: effectiveOpenclawToken,
        openclawChatEndpoint: effectiveOpenclawChatEndpoint,
        openclawModel: effectiveOpenclawModel,
    });

    // Persist discovered/prompted values to project JSON config
    persistToProjectConfig(effectiveOpenclawUrl, effectiveOpenclawChatEndpoint, effectiveOpenclawModel);

    // Ensure a basic roster exists; if not, create a minimal one-on-one config.
    if (!rosterOk) {
        note(
            [
                "Your project config is missing a team roster.",
                "We'll create a minimal default roster so you can start working,",
                "and you can refine it later via `teamclaw onboard` or `teamclaw config`.",
            ].join("\n"),
            "Missing roster",
        );

        const data = { ...tc.data };
        if (!Array.isArray((data as Record<string, unknown>).roster)) {
            (data as Record<string, unknown>).roster = [
                {
                    role: "Engineer",
                    count: 3,
                    description: "Builds product features and infrastructure.",
                },
                {
                    role: "Designer",
                    count: 1,
                    description: "Designs UX/UI and product visuals.",
                },
            ];
        }

        writeTeamclawConfig(tc.path, data);
        clearTeamConfigCache();
        const title = pc.green("Roster initialized");
        note(
            [
                "Created a default roster:",
                "- Engineer x3",
                "- Designer x1",
                "",
                "You can customize this later in `teamclaw.config.json` or via the onboarding wizard.",
            ].join("\n"),
            title,
        );
    }
}

function persistToProjectConfig(url: string, chatEndpoint: string, model: string): void {
    const tc = readTeamclawConfig();
    const persisted = { ...tc.data } as Record<string, unknown>;
    let changed = false;
    if (url && persisted["worker_url"] !== url) {
        persisted["worker_url"] = url;
        changed = true;
    }
    if (chatEndpoint && persisted["openclaw_chat_endpoint"] !== chatEndpoint) {
        persisted["openclaw_chat_endpoint"] = chatEndpoint;
        changed = true;
    }
    if (model && persisted["openclaw_model"] !== model) {
        persisted["openclaw_model"] = model;
        changed = true;
    }
    if (changed) {
        writeTeamclawConfig(tc.path, persisted);
        clearTeamConfigCache();
    }
}
