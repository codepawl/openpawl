import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Re-export port scanner types and functions so existing imports keep working.
export { discoverOpenAIApi } from "./port-scanner.js";
export type { OpenAIApiDiscoveryOptions } from "./port-scanner.js";

export interface OpenAIApiDiscovery {
    baseUrl: string;
    port: number;
    protocol: "http" | "ws";
    serviceName: string;
    chatEndpoint: string;
    models: string[];
}

/**
 * Values extracted directly from a local OpenClaw server config file.
 * When present these are authoritative — no network probe or token prompt needed.
 */
export interface LocalOpenClawConfig {
    /** Numeric port from gateway.port (WebSocket gateway port) */
    port: number;
    /** HTTP API port from gateway.http.port (defaults to 18789) */
    httpPort: number;
    /** Auth token from gateway.auth.token */
    token: string;
    /** Primary model from agents.defaults.model.primary (may be empty) */
    model: string;
    /** Fallback models from agents.defaults.model.fallbacks */
    fallbackModels: string[];
    /** All available models (primary + fallbacks + any defined in models) */
    availableModels: string[];
    /** Ready-to-use WebSocket URL: ws://127.0.0.1:<port> */
    url: string;
    /** Ready-to-use HTTP API URL: http://127.0.0.1:<httpPort> */
    httpUrl: string;
    /** Absolute path to the config file that was read (for display only) */
    configPath: string;
    /** Whether authentication is required. False if gateway.auth.mode === "none" */
    authRequired: boolean;
    /** Model aliases extracted from agents.defaults.model.models[].alias */
    aliases: Record<string, string>;
}

/** Loose shape of the OpenClaw JSON config file. */
interface RawOpenClawConfig {
    gateway?: {
        port?: unknown;
        bind?: string;
        auth?: {
            mode?: unknown;
            token?: unknown;
        };
        http?: {
            port?: unknown;
        };
    };
    agents?: {
        defaults?: {
            model?: {
                primary?: unknown;
                fallbacks?: unknown[];
                models?: Record<string, { alias?: string }>;
            };
        };
    };
}

/**
 * Returns an ordered list of filesystem paths to check for the OpenClaw
 * server config file, most-preferred first.
 */
function getOpenClawConfigCandidates(): string[] {
    const home = os.homedir();
    const candidates: string[] = [];

    if (process.platform === "win32") {
        // AppData/Roaming is the conventional install location on Windows.
        const appData = process.env["APPDATA"];
        if (appData) {
            // openclaw.json is the primary filename used by the OpenClaw installer.
            candidates.push(path.join(appData, "openclaw", "openclaw.json"));
            candidates.push(path.join(appData, "openclaw", "config.json"));
        }
        const localAppData = process.env["LOCALAPPDATA"];
        if (localAppData) {
            candidates.push(
                path.join(localAppData, "openclaw", "openclaw.json"),
            );
            candidates.push(path.join(localAppData, "openclaw", "config.json"));
        }
    }

    // Primary cross-platform location used by the default OpenClaw installer.
    // openclaw.json is checked first — that is the actual filename the installer writes.
    candidates.push(path.join(home, ".openclaw", "openclaw.json"));
    candidates.push(path.join(home, ".openclaw", "config.json"));

    // XDG_CONFIG_HOME if set, otherwise ~/.config (Linux / macOS).
    const xdgBase =
        process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
    candidates.push(path.join(xdgBase, "openclaw", "openclaw.json"));
    candidates.push(path.join(xdgBase, "openclaw", "config.json"));

    return candidates;
}

/**
 * Attempts to read and parse the local OpenClaw server configuration file.
 * Returns null when no valid file is found.
 *
 * Extraction map:
 *   port  ← gateway.port
 *   token ← gateway.auth.token
 *   model ← agents.defaults.model.primary
 *   url   ← ws://127.0.0.1:<port>  (always loopback — matches gateway.bind default)
 */
export function readLocalOpenClawConfig(): LocalOpenClawConfig | null {
    const candidates = getOpenClawConfigCandidates();

    for (const configPath of candidates) {
        try {
            const raw = readFileSync(configPath, "utf8");
            const data = JSON.parse(raw) as RawOpenClawConfig;

            // --- port ---
            const portRaw = data.gateway?.port;
            const port =
                typeof portRaw === "number"
                    ? portRaw
                    : Number.parseInt(String(portRaw ?? ""), 10);
            if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;

            // --- auth mode ---
            const authMode = data.gateway?.auth?.mode;
            const isAuthDisabled = authMode === "none";

            // --- token ---
            const tokenRaw = data.gateway?.auth?.token;
            const token = (typeof tokenRaw === "string" ? tokenRaw : "").trim();

            // If auth is disabled, we don't need a token. Otherwise token is required.
            if (!isAuthDisabled && !token) continue;

            // --- http port (optional, defaults to 18789) ---
            const httpPortRaw = data.gateway?.http?.port;
            const httpPortParsed =
                typeof httpPortRaw === "number"
                    ? httpPortRaw
                    : Number.parseInt(String(httpPortRaw ?? ""), 10);
            const httpPort =
                Number.isInteger(httpPortParsed) && httpPortParsed > 0 && httpPortParsed <= 65535
                    ? httpPortParsed
                    : 18789;

            // --- model (optional) ---
            const modelRaw = data.agents?.defaults?.model?.primary;
            const model = (typeof modelRaw === "string" ? modelRaw : "").trim();

            // --- fallback models (optional) ---
            const fallbacksRaw = data.agents?.defaults?.model?.fallbacks;
            const fallbackModels: string[] = Array.isArray(fallbacksRaw)
                ? fallbacksRaw.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter(Boolean)
                : [];

            // --- all available models (primary + fallbacks + defined models) ---
            const modelsDef = data.agents?.defaults?.model?.models;
            const definedModels: string[] = modelsDef && typeof modelsDef === "object"
                ? Object.keys(modelsDef).filter((k) => k.trim())
                : [];

            // Primary, fallbacks, and any models defined in the config
            const allModels = [model, ...fallbackModels, ...definedModels]
                .filter((m, i, arr) => m && arr.indexOf(m) === i);
            const availableModels: string[] = allModels.filter(Boolean);

            // Extract aliases from models[].alias
            const aliases: Record<string, string> = {};
            if (modelsDef && typeof modelsDef === "object") {
                for (const [modelId, def] of Object.entries(modelsDef)) {
                    if (def && typeof def.alias === "string" && def.alias.trim()) {
                        aliases[def.alias.trim()] = modelId.trim();
                    }
                }
            }

            return {
                port,
                httpPort,
                token,
                model,
                fallbackModels,
                availableModels,
                url: `ws://127.0.0.1:${port}`,
                httpUrl: `http://127.0.0.1:${httpPort}`,
                configPath,
                authRequired: !isAuthDisabled,
                aliases,
            };
        } catch {
            // File missing or invalid JSON — try next candidate.
        }
    }

    return null;
}
