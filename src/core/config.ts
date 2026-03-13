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
import { readEnvFile, writeEnvFile, getEnvValue, setEnvValue } from "./envManager.js";

migrateEnvToGlobalJson();

export type MemoryBackend = "lancedb" | "local_json";
const GATEWAY_DEFAULT_MODEL = "gateway-default";

function loadGlobalConfig() {
    return readGlobalConfigWithDefaults();
}

const globalCfg = loadGlobalConfig() as unknown as Record<string, unknown>;

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

    chromadbPersistDir: getGlobalString("chromadbPersistDir", "data/vector_store"),
    memoryBackend: (getGlobalString("memoryBackend", "lancedb") as MemoryBackend),
    verboseLogging: getGlobalBoolean("verboseLogging", false),
    debugMode: getGlobalBoolean("debugMode", false),

    openclawWorkerUrl: String(globalCfg.gatewayUrl || ""),
    openclawHttpUrl: String(globalCfg.apiUrl || ""),
    openclawWorkers: {} as Record<string, string>,
    openclawToken: String(globalCfg.token || ""),
    openclawChatEndpoint: String(globalCfg.chatEndpoint || "/v1/chat/completions"),
    openclawModel: String(globalCfg.model || GATEWAY_DEFAULT_MODEL),
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

    const env = readEnvFile();
    const urlRaw = getEnvValue("OPENCLAW_WORKER_URL", env.lines);
    const tokenRaw = getEnvValue("OPENCLAW_TOKEN", env.lines);
    const chatEndpointRaw = getEnvValue("OPENCLAW_CHAT_ENDPOINT", env.lines);
    const modelRaw = getEnvValue("OPENCLAW_MODEL", env.lines);
    const openclawUrl = (urlRaw ?? "").trim();
    const openclawToken = 
        (tokenRaw ?? "").trim() || 
        (teamCfg?.openclaw_token ?? "").trim();
    const openclawChatEndpoint =
        (chatEndpointRaw ?? "").trim() ||
        (teamCfg?.openclaw_chat_endpoint ?? "").trim();
    const openclawModel =
        (modelRaw ?? "").trim() ||
        (teamCfg?.openclaw_model ?? "").trim() ||
        GATEWAY_DEFAULT_MODEL;

    let effectiveOpenclawUrl = openclawUrl;
    let effectiveOpenclawToken = openclawToken;
    let effectiveOpenclawChatEndpoint = openclawChatEndpoint;
    let effectiveOpenclawModel = openclawModel;
    let discoveredModels: string[] = [];
    // Track whether local config has auth disabled — used to skip token prompt
    let localConfigAuthNotRequired = false;
    // Mutable env lines — hoisted early so both the local-config block and the
    // fast-path return can accumulate and persist changes in a single write.
    let envLines = env.lines;

    // Eagerly fill any missing effective values from the local OpenClaw config
    // file BEFORE the fast-path check.  This matters when URL + token are
    // already persisted in .env from a prior run but endpoint/model were never
    // saved — without this the local config file was only consulted inside the
    // `if (!effectiveOpenclawUrl)` block below, which was skipped entirely
    // whenever the URL was already known.
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
            // Track if auth is disabled in local config — skip token prompt if so
            if (!earlyLocalCfg.authRequired) {
                localConfigAuthNotRequired = true;
            }
            // Only fill URL when it is completely absent — never override a URL
            // that is already set, because the config file's port may differ from
            // the port the running gateway process is actually bound to.
            if (!effectiveOpenclawUrl) {
                effectiveOpenclawUrl = earlyLocalCfg.url;
                envLines = setEnvValue(
                    "OPENCLAW_WORKER_URL",
                    effectiveOpenclawUrl,
                    envLines,
                );
            }
            // Always sync the HTTP API URL from local config (separate port from WS gateway)
            envLines = setEnvValue(
                "OPENCLAW_HTTP_URL",
                earlyLocalCfg.httpUrl,
                envLines,
            );
            applyRuntimeOpenClawConfig({ openclawHttpUrl: earlyLocalCfg.httpUrl });
            if (!effectiveOpenclawToken) {
                effectiveOpenclawToken = earlyLocalCfg.token;
                envLines = setEnvValue(
                    "OPENCLAW_TOKEN",
                    effectiveOpenclawToken,
                    envLines,
                );
            }
            if (!effectiveOpenclawChatEndpoint) {
                effectiveOpenclawChatEndpoint = "/v1/chat/completions";
                envLines = setEnvValue(
                    "OPENCLAW_CHAT_ENDPOINT",
                    effectiveOpenclawChatEndpoint,
                    envLines,
                );
            }
            // Always prefer the model from local OpenClaw config when available
            if (earlyLocalCfg.model) {
                effectiveOpenclawModel = earlyLocalCfg.model;
                envLines = setEnvValue(
                    "OPENCLAW_MODEL",
                    effectiveOpenclawModel,
                    envLines,
                );
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
        // Persist any values that were corrected/filled by the local config
        // file (e.g. stale port in .env, or missing endpoint/model).
        if (envLines !== env.lines) {
            writeEnvFile(env.path, envLines);
        }
        applyRuntimeOpenClawConfig({
            openclawWorkerUrl: effectiveOpenclawUrl,
            openclawToken: effectiveOpenclawToken,
            openclawChatEndpoint: effectiveOpenclawChatEndpoint,
            openclawModel: effectiveOpenclawModel,
        });
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
        const { runOnboard } = await import("../onboard/index.js");
        await runOnboard();
        clearTeamConfigCache();
        return;
    }

    // Otherwise, prompt only for missing scalar values here; leave rich roster
    // editing to the dedicated onboard flow if it's still missing.

    // Run Discovery only when the gateway URL itself is unknown, or the user
    // explicitly requested a re-scan via --discover.  If URL + token are both
    // present we have enough to connect — missing model/endpoint are filled by
    // the individual prompts below without touching the network scanner.
    if (!effectiveOpenclawUrl || opts.forceDiscover) {
        const s = spinner();
        s.start("🔍 Checking for local OpenClaw configuration...");

        // Prefer the local config file over network probing unless the user
        // explicitly asked for a network re-scan with --discover.
        const localCfg = opts.forceDiscover ? null : readLocalOpenClawConfig();

        if (localCfg) {
            // Track if auth is disabled in local config — skip token prompt if so
            if (!localCfg.authRequired) {
                localConfigAuthNotRequired = true;
            }
            // All four values can be read directly from the file — no prompts needed.
            effectiveOpenclawUrl = localCfg.url;
            effectiveOpenclawToken = localCfg.token;
            if (localCfg.model && !effectiveOpenclawModel) {
                effectiveOpenclawModel = localCfg.model;
            }
            if (!effectiveOpenclawChatEndpoint) {
                effectiveOpenclawChatEndpoint = "/v1/chat/completions";
            }

            envLines = setEnvValue(
                "OPENCLAW_WORKER_URL",
                effectiveOpenclawUrl,
                envLines,
            );
            envLines = setEnvValue(
                "OPENCLAW_TOKEN",
                effectiveOpenclawToken,
                envLines,
            );
            // Always sync the HTTP API URL from local config (separate port from WS gateway)
            envLines = setEnvValue(
                "OPENCLAW_HTTP_URL",
                localCfg.httpUrl,
                envLines,
            );
            if (effectiveOpenclawModel) {
                envLines = setEnvValue(
                    "OPENCLAW_MODEL",
                    effectiveOpenclawModel,
                    envLines,
                );
            }
            if (!openclawChatEndpoint) {
                envLines = setEnvValue(
                    "OPENCLAW_CHAT_ENDPOINT",
                    effectiveOpenclawChatEndpoint,
                    envLines,
                );
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
                    // Stop spinner BEFORE showing interactive menu — prevents the "spinning
                    // forever" look where the animation keeps running behind the select list.
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
                    // Single result — stop spinner now with service details.
                    s.stop(
                        `✅ Found ${selected.serviceName} at port ${selected.port} (${selected.protocol.toUpperCase()})`,
                    );
                }
                discoveredModels =
                    selected.protocol === "http" ? selected.models : [];
                // Always update URL when force-discovering so the new selection is
                // persisted for the rest of the session; otherwise only fill when empty.
                if (!effectiveOpenclawUrl || opts.forceDiscover) {
                    effectiveOpenclawUrl = selected.baseUrl;
                    envLines = setEnvValue(
                        "OPENCLAW_WORKER_URL",
                        effectiveOpenclawUrl,
                        envLines,
                    );
                    applyRuntimeOpenClawConfig({
                        openclawWorkerUrl: effectiveOpenclawUrl,
                    });
                }
                if (
                    !effectiveOpenclawChatEndpoint &&
                    selected.protocol === "http"
                ) {
                    effectiveOpenclawChatEndpoint = selected.chatEndpoint;
                    envLines = setEnvValue(
                        "OPENCLAW_CHAT_ENDPOINT",
                        effectiveOpenclawChatEndpoint,
                        envLines,
                    );
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
                    "Missing OpenClaw Gateway URL (OPENCLAW_WORKER_URL). Please enter it:",
                placeholder: "http://localhost:8001",
                validate: (v) =>
                    (v ?? "").trim().length > 0
                        ? undefined
                        : "URL cannot be empty",
            }),
        ) as string;
        const value = url.trim();
        if (value) {
            envLines = setEnvValue("OPENCLAW_WORKER_URL", value, envLines);
            effectiveOpenclawUrl = value;
            applyRuntimeOpenClawConfig({ openclawWorkerUrl: value });
        }
    }

    // Skip token prompt if auth is disabled in local config
    if (!effectiveOpenclawToken && !localConfigAuthNotRequired) {
        const token = handleInlineCancel(
            await password({
                message:
                    "Missing OpenClaw token (OPENCLAW_TOKEN). Please enter it:",
                validate: (v) =>
                    (v ?? "").trim().length > 0
                        ? undefined
                        : "Token cannot be empty",
            }),
        ) as string;
        const value = token.trim();
        if (value) {
            envLines = setEnvValue("OPENCLAW_TOKEN", value, envLines);
            effectiveOpenclawToken = value;
            applyRuntimeOpenClawConfig({ openclawToken: value });
        }
    }

    if (!effectiveOpenclawChatEndpoint) {
        const endpoint = handleInlineCancel(
            await text({
                message:
                    "Missing OpenClaw chat endpoint (OPENCLAW_CHAT_ENDPOINT). Please enter it:",
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
            envLines = setEnvValue("OPENCLAW_CHAT_ENDPOINT", value, envLines);
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
        const value = (discovered ?? GATEWAY_DEFAULT_MODEL).trim();
        envLines = setEnvValue("OPENCLAW_MODEL", value, envLines);
        effectiveOpenclawModel = value;
        applyRuntimeOpenClawConfig({ openclawModel: value });
    }

    if (envLines !== env.lines) {
        writeEnvFile(env.path, envLines);
    }

    // Ensure all resolved values are immediately available in this process even if
    // they came from existing .env/team config and no prompt branch executed.
    applyRuntimeOpenClawConfig({
        openclawWorkerUrl: effectiveOpenclawUrl,
        openclawToken: effectiveOpenclawToken,
        openclawChatEndpoint: effectiveOpenclawChatEndpoint,
        openclawModel: effectiveOpenclawModel,
    });

    const persisted = { ...tc.data } as Record<string, unknown>;
    let persistedChanged = false;
    if (
        effectiveOpenclawUrl &&
        persisted["worker_url"] !== effectiveOpenclawUrl
    ) {
        persisted["worker_url"] = effectiveOpenclawUrl;
        persistedChanged = true;
    }
    if (
        effectiveOpenclawChatEndpoint &&
        persisted["openclaw_chat_endpoint"] !== effectiveOpenclawChatEndpoint
    ) {
        persisted["openclaw_chat_endpoint"] = effectiveOpenclawChatEndpoint;
        persistedChanged = true;
    }
    if (
        effectiveOpenclawModel &&
        persisted["openclaw_model"] !== effectiveOpenclawModel
    ) {
        persisted["openclaw_model"] = effectiveOpenclawModel;
        persistedChanged = true;
    }
    if (persistedChanged) {
        writeTeamclawConfig(tc.path, persisted);
        clearTeamConfigCache();
    }

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
