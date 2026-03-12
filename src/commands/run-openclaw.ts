import { exec, spawn, ChildProcess } from "child_process";
import { text, spinner } from "@clack/prompts";
import { logger } from "../core/logger.js";
import { CONFIG } from "../core/config.js";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLocalOpenClawConfig } from "../core/discovery.js";

function commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
        exec(`command -v ${cmd}`, (err) => {
            resolve(!err);
        });
    });
}

export function detectPortFromConfig(): string {
    // First try to read from local OpenClaw config file
    const localCfg = readLocalOpenClawConfig();
    if (localCfg) {
        return String(localCfg.port);
    }
    
    // Then try from CONFIG
    const configuredUrl = CONFIG.openclawWorkerUrl ?? "";
    if (configuredUrl) {
        try {
            const urlStr = configuredUrl.includes("://")
                ? configuredUrl
                : `http://${configuredUrl}`;
            const url = new URL(urlStr);
            if (url.port) {
                return url.port;
            }
        } catch {
            // use default
        }
    }
    return "18789";
}

/**
 * Auto-detect the OpenClaw HTTP API port by reading the local openclaw.json config
 * file first (gateway.http.port), then falling back to OPENCLAW_HTTP_URL env var,
 * and finally defaulting to 18789.
 */
export function detectHttpPortFromConfig(): string {
    // 1. Try OPENCLAW_HTTP_URL env var (may have been set by validateOrPromptConfig)
    const envHttpUrl = (process.env["OPENCLAW_HTTP_URL"] ?? "").trim();
    if (envHttpUrl) {
        try {
            const url = new URL(envHttpUrl);
            if (url.port) return url.port;
        } catch {
            // fall through
        }
    }

    // 2. Try reading ~/.openclaw/openclaw.json directly
    try {
        const localCfg = readLocalOpenClawConfig();
        if (localCfg && localCfg.httpPort > 0) {
            return String(localCfg.httpPort);
        }
    } catch {
        // ignore
    }

    // 3. Default
    return "18789";
}

export async function isPortInUse(port: number | string): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        server.once("listening", () => {
            server.close();
            resolve(false);
        });
        server.listen(Number(port), "127.0.0.1");
    });
}

export interface StartGatewayOptions {
    port?: string;
    skipPrompt?: boolean;
}

export async function startOpenclawGateway(options: StartGatewayOptions = {}): Promise<void> {
    const { port: explicitPort, skipPrompt } = options;

    let port = explicitPort;

    if (!port && !skipPrompt) {
        const detectedPort = detectPortFromConfig();
        const input = await text({
            message: `Enter OpenClaw gateway port`,
            defaultValue: detectedPort,
            placeholder: detectedPort,
        });
        port = (input as string).trim() || detectedPort;
    } else if (!port) {
        port = detectPortFromConfig();
    }

    const child = await startGatewayBinary(port);
    const pid = child.pid ?? -1;
    const logPath = getGatewayLogPath();

    const ready = await waitForPort(port, 10000);

    if (!ready) {
        logger.error(`Gateway failed to start within 10 seconds on port ${port}`);
        logger.plain(`Check log at: ${logPath}`);
        process.exit(1);
    }

    logger.success(`OpenClaw gateway is running in the background on port ${port}.`);
    logger.plain(`PID: ${pid}`);
    logger.plain(`Log: ${logPath}`);

    process.exit(0);
}

async function findOpenclawCommand(): Promise<string | null> {
    const openclawCmd = "openclaw";
    const npxCmd = "npx";

    const hasOpenclaw = await commandExists(openclawCmd);
    if (hasOpenclaw) return openclawCmd;

    const hasNpx = await commandExists(npxCmd);
    if (hasNpx) return npxCmd;

    return null;
}

function getGatewayLogPath(): string {
    const homeDir = os.homedir();
    const openclawDir = path.join(homeDir, ".openclaw");
    if (!fs.existsSync(openclawDir)) {
        fs.mkdirSync(openclawDir, { recursive: true });
    }
    return path.join(openclawDir, "teamclaw-gateway.log");
}

export async function startGatewayBinary(port: string): Promise<ChildProcess> {
    const cmd = await findOpenclawCommand();

    if (!cmd) {
        logger.error("Neither 'openclaw' nor 'npx' found in PATH.");
        logger.plain("");
        logger.plain("To install OpenClaw:");
        logger.plain("  npm install -g openclaw");
        logger.plain("  # or");
        logger.plain("  pnpm add -g openclaw");
        process.exit(1);
    }

    const args = cmd === "openclaw"
        ? ["gateway", "--port", port]
        : ["openclaw", "gateway", "--port", port];

    const logPath = getGatewayLogPath();
    const logStream = fs.openSync(logPath, "a");

    const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", logStream, logStream],
        shell: false,
    });

    child.unref();

    return child;
}

export async function waitForPort(
    port: number | string,
    timeoutMs: number = 10000
): Promise<boolean> {
    const start = Date.now();
    const portNum = Number(port);

    while (Date.now() - start < timeoutMs) {
        const inUse = await isPortInUse(portNum);
        if (inUse) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

export interface ManagedGatewayState {
    pid: number | null;
    wasAlreadyRunning: boolean;
}

let managedGateway: {
    process: ChildProcess;
    pid: number;
    wasAlreadyRunning: boolean;
} | null = null;

export async function startManagedGateway(
    port: string,
    options: { useSpinner?: boolean } = {}
): Promise<ManagedGatewayState> {
    const portNum = Number(port);
    const wasAlreadyRunning = await isPortInUse(portNum);

    if (wasAlreadyRunning) {
        logger.info(`Gateway already running on port ${port}`);
        return { pid: null, wasAlreadyRunning: true };
    }

    const s = options.useSpinner ? spinner() : null;
    s?.start(`Starting managed OpenClaw gateway on port ${port}...`);

    const child = await startGatewayBinary(port);
    const pid = child.pid ?? -1;

    const ready = await waitForPort(portNum, 10000);

    if (!ready) {
        s?.stop("Failed to start gateway (timeout)");
        logger.error(`Gateway failed to start within 10 seconds on port ${port}`);
        child.kill();
        process.exit(1);
    }

    s?.stop(`Gateway started on port ${port}`);

    managedGateway = {
        process: child,
        pid,
        wasAlreadyRunning: false,
    };

    return { pid, wasAlreadyRunning: false };
}

export function cleanupManagedGateway(): void {
    if (managedGateway && !managedGateway.wasAlreadyRunning) {
        try {
            process.kill(managedGateway.pid);
            logger.info(`Killed managed gateway (PID: ${managedGateway.pid})`);
        } catch {
            // Process may have already exited
        }
        managedGateway = null;
    }
}

export function setupGatewayCleanupHandlers(): void {
    const cleanup = () => {
        cleanupManagedGateway();
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
    });
}
