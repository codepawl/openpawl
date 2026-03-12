/**
 * Pillar 1: Dedicated Setup Phase — `teamclaw setup` / `teamclaw init`
 *
 * Guides the user through setting up their OpenClaw gateway connection and
 * saves the result to a persistent config so that `teamclaw work` never needs
 * to ask infrastructure questions at runtime.
 *
 * Flow:
 *  1. Ask whether TeamClaw should manage/spawn OpenClaw automatically.
 *  2a. YES → auto-configure default ports and settings.
 *  2b. NO  → prompt for Gateway Port, IP and Token.
 *  3. Auto-detect: ping the provided config to verify connectivity and model.
 *  4. Save to ~/.teamclaw/config.json (persistent machine config).
 *     Also mirror to .env/teamclaw.config.json for backwards compatibility.
 *  5. Final prompt: "Start a work session now, or exit?"
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
import { readEnvFile, writeEnvFile, setEnvValue } from "../core/envManager.js";
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
    type TeamClawGlobalConfig,
} from "../core/global-config.js";

/** Default port when TeamClaw manages the gateway automatically. */
const MANAGED_GATEWAY_PORT = "8001";
const MANAGED_GATEWAY_IP = "127.0.0.1";
const GATEWAY_DEFAULT_MODEL = "gateway-default";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to verify connectivity and auto-detect gateway model.
 *
 * OpenClaw port layout:
 *   WS  gateway  port (e.g. 8001) — websocket coordination
 *   API HTTP     port (WS+2, e.g. 8003) — OpenAI-compatible LLM endpoint
 *
 * We probe BOTH:
 *   1. WS port via HTTP ping — confirms the gateway process is alive.
 *   2. API port (WS+2)      — fetches available models for verification.
 *
 * Returns `{ reachable, apiPort, model }`.
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

    // ── Step 1: Connectivity check on the WS gateway port ────────────────────
    const wsBase = `http://${ip}:${wsPort}`;
    let wsReachable = false;
    for (const path of ["/__openclaw__/api/config", "/api/status", "/"]) {
        try {
            const res = await fetch(`${wsBase}${path}`, {
                headers,
                signal: AbortSignal.timeout(3000),
            });
            // Any response (even 404) means the process is up
            wsReachable = true;
            // Also try to extract model from the config endpoint shape
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

    // ── Step 2: Model discovery on the API port (WS+2) ───────────────────────
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

            // /v1/models response shape: { data: [{ id: "..." }] }
            const models = (data.data as Array<{ id?: string }> | undefined) ?? [];
            const firstModel = models.find(
                (m) => typeof m.id === "string" && m.id.trim().length > 0,
            )?.id;
            if (firstModel) return { reachable: true, apiPort, model: firstModel.trim() };

            // Flat model field
            const flatModel = data.model as string | undefined;
            if (typeof flatModel === "string" && flatModel.trim().length > 0)
                return { reachable: true, apiPort, model: flatModel.trim() };

            // API is reachable, no model info found
            return { reachable: true, apiPort, model: null };
        } catch {
            // try next
        }
    }

    // Gateway port reachable but no API response → still report reachable
    if (wsReachable) {
        return { reachable: true, apiPort, model: null };
    }

    return { reachable: false, apiPort, model: null };
}

interface SetupResult {
    gatewayPort: string;
    /** The OpenAI-compatible HTTP API port (= gateway WS port + 2). */
    apiPort: number;
    gatewayIp: string;
    token: string;
    model: string;
    managed: boolean;
}

function isLocalHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
}

/**
 * Persist gateway settings to .env and teamclaw.config.json.
 *
 * Saves TWO separate URLs:
 *   OPENCLAW_WORKER_URL   = ws://<ip>:<wsPort>      (WebSocket gateway)
 *   OPENCLAW_HTTP_URL     = http://<ip>:<apiPort>   (OpenAI-compatible API, WS+2)
 *
 * This eliminates the port confusion that causes HTTP 404 errors when the
 * LLM client tries to hit the WS port instead of the API port.
 */
function persistConfig(result: SetupResult): void {
    const wsUrl = `ws://${result.gatewayIp}:${result.gatewayPort}`;
    // API port is gateway WS port + 2 (e.g. 8001 → 8003)
    const httpUrl = `http://${result.gatewayIp}:${result.apiPort}`;

    const envFile = readEnvFile();
    let lines = envFile.lines;
    lines = setEnvValue("OPENCLAW_WORKER_URL", wsUrl, lines);
    lines = setEnvValue("OPENCLAW_HTTP_URL", httpUrl, lines);
    lines = setEnvValue("OPENCLAW_TOKEN", result.token, lines);
    lines = setEnvValue("OPENCLAW_CHAT_ENDPOINT", "/v1/chat/completions", lines);
    if (result.model) lines = setEnvValue("OPENCLAW_MODEL", result.model, lines);
    writeEnvFile(envFile.path, lines);

    const tc = readTeamclawConfig();
    const data: Record<string, unknown> = {
        ...tc.data,
        worker_url: wsUrl,
        openclaw_http_url: httpUrl,
        openclaw_chat_endpoint: "/v1/chat/completions",
    };
    if (result.model) data.openclaw_model = result.model;
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

    setOpenClawWorkerUrl(wsUrl);
    setOpenClawHttpUrl(httpUrl);
    if (result.model) setOpenClawModel(result.model);
    setOpenClawToken(result.token);
    setOpenClawChatEndpoint("/v1/chat/completions");
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

    // -------------------------------------------------------------------------
    // Step 1: managed vs manual
    // -------------------------------------------------------------------------
    const managedChoice = await confirm({
        message:
            "Should TeamClaw automatically manage/spawn the OpenClaw Gateway for you?",
        initialValue: true,
    });

    if (isCancel(managedChoice)) {
        cancel("Setup cancelled.");
        process.exit(0);
    }

    const managed = managedChoice as boolean;

    let gatewayPort = MANAGED_GATEWAY_PORT;
    let gatewayIp = MANAGED_GATEWAY_IP;
    let token = "";

    if (managed) {
        // -----------------------------------------------------------------------
        // Step 2a: Auto-configure
        // -----------------------------------------------------------------------
        note(
            [
                `TeamClaw will spawn OpenClaw on ${pc.cyan(`${gatewayIp}:${gatewayPort}`)} when you run ${pc.green("teamclaw work")}.`,
                "",
                "You can change these defaults later by re-running `teamclaw setup`.",
            ].join("\n"),
            "Auto-Managed Gateway",
        );
    } else {
        // -----------------------------------------------------------------------
        // Step 2b: Manual — prompt for IP, Port and Token
        // -----------------------------------------------------------------------
        const portInput = await text({
            message: "Gateway Port:",
            initialValue: MANAGED_GATEWAY_PORT,
            placeholder: MANAGED_GATEWAY_PORT,
            validate: (v) => {
                const n = Number(v?.trim());
                return Number.isInteger(n) && n > 0 && n <= 65535
                    ? undefined
                    : "Port must be a number between 1 and 65535";
            },
        });
        if (isCancel(portInput)) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        gatewayPort = (portInput as string).trim() || MANAGED_GATEWAY_PORT;

        const ipInput = await text({
            message: "Gateway IP / Hostname:",
            initialValue: MANAGED_GATEWAY_IP,
            placeholder: MANAGED_GATEWAY_IP,
            validate: (v) =>
                (v ?? "").trim().length > 0 ? undefined : "IP cannot be empty",
        });
        if (isCancel(ipInput)) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        gatewayIp = (ipInput as string).trim() || MANAGED_GATEWAY_IP;

        const tokenInput = await password({
            message:
                "Gateway Auth Token (press Enter to skip if auth is disabled):",
        });
        if (isCancel(tokenInput)) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        token = (tokenInput as string).trim();
    }

    // -------------------------------------------------------------------------
    // Step 3: Auto-detect — ping the gateway to verify connectivity + model
    // -------------------------------------------------------------------------
    const s = spinner();
    s.start(`🔍 Pinging gateway at ${gatewayIp}:${gatewayPort}…`);

    const pingResult = await pingGateway(gatewayIp, gatewayPort, token);

    const detectedModel = pingResult.model?.trim() || GATEWAY_DEFAULT_MODEL;

    if (pingResult.reachable) {
        s.stop("✅ Gateway is reachable! (Model handling delegated to Gateway)");
    } else {
        s.stop(
            pc.yellow(
                `⚠️  Could not reach gateway at ${gatewayIp}:${gatewayPort}. Settings will be saved anyway.`,
            ),
        );
        note(
            [
                "The gateway may not be running yet — that's okay!",
                managed
                    ? `TeamClaw will start it automatically when you run ${pc.green("teamclaw work")}.`
                    : `Start it manually and then run ${pc.green("teamclaw work")}.`,
            ].join("\n"),
            "Gateway not reachable",
        );
    }

    // -------------------------------------------------------------------------
    // Step 4: Save config
    // -------------------------------------------------------------------------
    const apiPort = pingResult.apiPort;

    const globalConfig: TeamClawGlobalConfig = {
        version: 1,
        managedGateway: managed,
        gatewayHost: gatewayIp,
        gatewayPort: Number(gatewayPort),
        apiPort,
        gatewayUrl: `ws://${gatewayIp}:${gatewayPort}`,
        apiUrl: `http://${gatewayIp}:${apiPort}`,
        token,
        model: detectedModel,
        chatEndpoint: "/v1/chat/completions",
        dashboardPort: 9001,
    };
    const globalConfigPath = writeGlobalConfig(globalConfig);

    persistConfig({
        gatewayPort,
        apiPort,
        gatewayIp,
        token,
        model: detectedModel,
        managed,
    });

    note(
        [
            `${pc.green("✓")} WS Gateway   : ${pc.cyan(`ws://${gatewayIp}:${gatewayPort}`)}`,
            `${pc.green("✓")} API HTTP URL : ${pc.cyan(`http://${gatewayIp}:${apiPort}`)} ${pc.dim("(port = WS+2)")}`,
            `${pc.green("✓")} Token        : ${token ? pc.dim("saved (masked)") : pc.dim("none (auth disabled)")}`,
            `${pc.green("✓")} Model        : ${detectedModel ? pc.cyan(detectedModel) : pc.dim("(set later)")}`,
            `${pc.green("✓")} Managed      : ${managed ? pc.green("yes — auto-spawn on `teamclaw work`") : pc.dim("no (external gateway)")}`,
            `${pc.green("✓")} Global Config: ${pc.cyan(globalConfigPath)}`,
            "",
            "Config saved to ~/.teamclaw/config.json (+ mirrored to .env/teamclaw.config.json)",
        ].join("\n"),
        "Setup Complete!",
    );

    if (!managed && isLocalHost(gatewayIp)) {
        note(
            "Managed gateway is disabled. `teamclaw work` will connect using saved config and will not auto-spawn OpenClaw.",
            "External Gateway Mode",
        );
    }

    // -------------------------------------------------------------------------
    // Step 5: Final prompt — start work session or exit
    // -------------------------------------------------------------------------
    const nextStep = await select({
        message: "What would you like to do next?",
        options: [
            {
                value: "work",
                label: "🚀 Start a work session now  (teamclaw work)",
            },
            {
                value: "exit",
                label: "🚪 Exit — I'll run `teamclaw work` later",
            },
        ],
    });

    if (isCancel(nextStep)) {
        outro("Setup complete. Run `teamclaw work` whenever you're ready.");
        return;
    }

    if (nextStep === "work") {
        outro("Launching work session…");
        const { runWork } = await import("../work-runner.js");
        await runWork({ args: [], noWeb: false });
    } else {
        outro(
            `Setup complete! Run ${pc.green("teamclaw work")} whenever you're ready.`,
        );
    }
}
