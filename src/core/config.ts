/**
 * Global configuration for TeamClaw.
 * Loads from Global JSON (~/.teamclaw/config.json) and Workspace JSON (teamclaw.config.json).
 * Priority: CLI Flags → Global JSON → Workspace JSON → Defaults.
 */

import { readGlobalConfigWithDefaults } from "./global-config.js";
import { setConfigAgentModels } from "./model-config.js";

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

    thinkingLevel: getGlobalString("thinkingLevel", "adaptive"),

    webhookOnTaskComplete: getGlobalString("webhookOnTaskComplete", ""),
    webhookOnCycleEnd: getGlobalString("webhookOnCycleEnd", ""),
    webhookSecret: getGlobalString("webhookSecret", ""),

    webhookApprovalUrl: (() => {
        const wa = (globalCfg as Record<string, unknown>).webhookApproval;
        if (wa && typeof wa === "object" && !Array.isArray(wa)) {
            const url = (wa as Record<string, unknown>).url;
            return typeof url === "string" ? url.trim() : "";
        }
        return "";
    })(),
    webhookApprovalSecret: (() => {
        const wa = (globalCfg as Record<string, unknown>).webhookApproval;
        if (wa && typeof wa === "object" && !Array.isArray(wa)) {
            const secret = (wa as Record<string, unknown>).secret;
            if (typeof secret === "string" && secret.trim()) return secret.trim();
        }
        return getGlobalString("webhookSecret", "");
    })(),
    webhookApprovalProvider: (() => {
        const wa = (globalCfg as Record<string, unknown>).webhookApproval;
        if (wa && typeof wa === "object" && !Array.isArray(wa)) {
            const p = (wa as Record<string, unknown>).provider;
            if (p === "slack") return "slack" as const;
        }
        return "generic" as const;
    })(),
    webhookApprovalTimeoutSeconds: (() => {
        const wa = (globalCfg as Record<string, unknown>).webhookApproval;
        if (wa && typeof wa === "object" && !Array.isArray(wa)) {
            const t = (wa as Record<string, unknown>).timeoutSeconds;
            if (typeof t === "number" && Number.isFinite(t) && t > 0) return t;
        }
        return 300;
    })(),
    webhookApprovalRetryAttempts: (() => {
        const wa = (globalCfg as Record<string, unknown>).webhookApproval;
        if (wa && typeof wa === "object" && !Array.isArray(wa)) {
            const r = (wa as Record<string, unknown>).retryAttempts;
            if (typeof r === "number" && Number.isFinite(r) && r > 0) return r;
        }
        return 3;
    })(),

    confidenceScoringEnabled: (() => {
        const cs = (globalCfg as Record<string, unknown>).confidenceScoring;
        if (cs && typeof cs === "object" && !Array.isArray(cs)) {
            return (cs as Record<string, unknown>).enabled !== false;
        }
        return true;
    })(),
    personalityEnabled: (() => {
        const p = (globalCfg as Record<string, unknown>).personality;
        if (p && typeof p === "object" && !Array.isArray(p)) {
            return (p as Record<string, unknown>).enabled !== false;
        }
        return false;
    })(),
    personalityPushbackEnabled: (() => {
        const p = (globalCfg as Record<string, unknown>).personality;
        if (p && typeof p === "object" && !Array.isArray(p)) {
            return (p as Record<string, unknown>).pushbackEnabled !== false;
        }
        return true;
    })(),
    personalityCoordinatorIntervention: (() => {
        const p = (globalCfg as Record<string, unknown>).personality;
        if (p && typeof p === "object" && !Array.isArray(p)) {
            return (p as Record<string, unknown>).coordinatorIntervention !== false;
        }
        return true;
    })(),
    personalityAgentOverrides: (() => {
        const p = (globalCfg as Record<string, unknown>).personality;
        if (p && typeof p === "object" && !Array.isArray(p)) {
            const overrides = (p as Record<string, unknown>).agentOverrides;
            if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
                return overrides as Record<string, { enabled?: boolean }>;
            }
        }
        return {} as Record<string, { enabled?: boolean }>;
    })(),

    confidenceThresholds: (() => {
        const defaults = { autoApprove: 0.85, reviewRequired: 0.60, reworkRequired: 0.40 };
        const cs = (globalCfg as Record<string, unknown>).confidenceScoring;
        if (cs && typeof cs === "object" && !Array.isArray(cs)) {
            const th = (cs as Record<string, unknown>).thresholds;
            if (th && typeof th === "object" && !Array.isArray(th)) {
                const t = th as Record<string, unknown>;
                return {
                    autoApprove: typeof t.autoApprove === "number" ? t.autoApprove : defaults.autoApprove,
                    reviewRequired: typeof t.reviewRequired === "number" ? t.reviewRequired : defaults.reviewRequired,
                    reworkRequired: typeof t.reworkRequired === "number" ? t.reworkRequired : defaults.reworkRequired,
                };
            }
        }
        return defaults;
    })(),
} as const;

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

export function updateSessionCreativity(value: number): void {
    sessionOverrides = { ...sessionOverrides, creativity: Math.max(0, Math.min(1, value)) };
}

export function clearSessionConfig(): void {
    sessionOverrides = {};
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

export function isPersonalityEnabled(role?: string): boolean {
    if (!CONFIG.personalityEnabled) return false;
    if (role) {
        const override = CONFIG.personalityAgentOverrides[role];
        if (override && typeof override.enabled === "boolean") return override.enabled;
    }
    return true;
}

// Re-export validateOrPromptConfig from the extracted module
export { validateOrPromptConfig } from "./config-prompts.js";
