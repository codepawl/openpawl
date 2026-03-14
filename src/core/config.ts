/**
 * Global configuration for TeamClaw.
 * Loads from Global JSON (~/.teamclaw/config.json) and Workspace JSON (teamclaw.config.json).
 * Priority: CLI Flags → Global JSON → Workspace JSON → Defaults.
 */

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
    llmTimeoutMs: getGlobalNumber("llmTimeoutMs", 300_000),

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
    thinkingLevel: getGlobalString("thinkingLevel", "adaptive"),

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

// Re-export validateOrPromptConfig from the extracted module
export { validateOrPromptConfig } from "./config-prompts.js";
