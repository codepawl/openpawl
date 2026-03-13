/**
 * Config Migrator - Moves .env values to Global JSON config.
 * This runs once on startup to migrate legacy .env configurations.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface GlobalConfig {
    version?: number;
    migratedFromEnv?: boolean;
    token?: string;
    gatewayUrl?: string;
    apiUrl?: string;
    model?: string;
    chatEndpoint?: string;
    [key: string]: unknown;
}

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".teamclaw", "config.json");
const ENV_FILE_PATH = path.join(process.cwd(), ".env");

function getGlobalConfigDir(): string {
    return path.dirname(GLOBAL_CONFIG_PATH);
}

function ensureGlobalConfigDir(): void {
    const dir = getGlobalConfigDir();
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function readGlobalConfig(): GlobalConfig {
    if (!existsSync(GLOBAL_CONFIG_PATH)) {
        return {};
    }
    try {
        const raw = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
        return JSON.parse(raw) as GlobalConfig;
    } catch {
        return {};
    }
}

function writeGlobalConfig(config: GlobalConfig): void {
    ensureGlobalConfigDir();
    writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function readEnvFile(): Record<string, string> {
    const result: Record<string, string> = {};
    if (!existsSync(ENV_FILE_PATH)) {
        return result;
    }
    try {
        const raw = readFileSync(ENV_FILE_PATH, "utf-8");
        const lines = raw.replace(/\r\n/g, "\n").split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const idx = trimmed.indexOf("=");
            if (idx < 0) continue;
            const key = trimmed.slice(0, idx).trim();
            const value = trimmed.slice(idx + 1).trim();
            result[key] = value;
        }
    } catch {
        // Ignore errors
    }
    return result;
}

export function migrateEnvToGlobalJson(): boolean {
    const globalConfig = readGlobalConfig();

    if (globalConfig.migratedFromEnv) {
        return false;
    }

    const envVars = readEnvFile();

    const hasOpenclawVars =
        envVars.OPENCLAW_TOKEN ||
        envVars.OPENCLAW_WORKER_URL ||
        envVars.OPENCLAW_HTTP_URL ||
        envVars.OPENCLAW_MODEL;

    if (!hasOpenclawVars) {
        globalConfig.migratedFromEnv = true;
        writeGlobalConfig(globalConfig);
        return false;
    }

    if (envVars.OPENCLAW_TOKEN) {
        globalConfig.token = envVars.OPENCLAW_TOKEN;
    }

    if (envVars.OPENCLAW_WORKER_URL) {
        globalConfig.gatewayUrl = envVars.OPENCLAW_WORKER_URL;
    }

    if (envVars.OPENCLAW_HTTP_URL) {
        globalConfig.apiUrl = envVars.OPENCLAW_HTTP_URL;
    }

    if (envVars.OPENCLAW_MODEL) {
        globalConfig.model = envVars.OPENCLAW_MODEL;
    }

    if (envVars.OPENCLAW_CHAT_ENDPOINT) {
        globalConfig.chatEndpoint = envVars.OPENCLAW_CHAT_ENDPOINT;
    }

    globalConfig.migratedFromEnv = true;
    writeGlobalConfig(globalConfig);

    return true;
}
