/**
 * Gateway initialization, health checks, and error recovery flows.
 */

import { spinner, select, isCancel } from "@clack/prompts";
import { randomPhrase } from "../utils/spinner-phrases.js";
import { logger } from "../core/logger.js";
import { isPortInUse, setupGatewayCleanupHandlers } from "../commands/run-openclaw.js";
import { runGatewayHealthCheck } from "../core/health.js";
import { formatFlatError } from "./outcome-reporter.js";
import { readLocalOpenClawConfig } from "../core/discovery.js";

export type GatewaySetupConfig = {
    gatewayPort: number;
    gatewayUrl: string;
    apiUrl: string;
    token: string;
    managedGateway: boolean;
};

async function waitForManagedGatewayReady(
    gatewayPort: number,
    token: string,
): Promise<boolean> {
    // Build candidate ports: openclaw config httpPort, legacy +2, and gateway port itself
    const openclawCfg = readLocalOpenClawConfig();
    const candidatePorts = new Set<number>();
    if (openclawCfg?.httpPort) candidatePorts.add(openclawCfg.httpPort);
    candidatePorts.add(gatewayPort + 2);
    candidatePorts.add(gatewayPort);

    // Multiple endpoints per port — /__openclaw__/api/config is the most reliable
    const endpoints = ["/__openclaw__/api/config", "/v1/models"];

    const candidateUrls: string[] = [];
    for (const port of candidatePorts) {
        for (const ep of endpoints) {
            candidateUrls.push(`http://127.0.0.1:${port}${ep}`);
        }
    }

    const headers: Record<string, string> = {};
    if (token.trim()) {
        headers.Authorization = `Bearer ${token.trim()}`;
    }

    let attempts = 0;
    while (attempts < 10) {
        attempts += 1;
        for (const url of candidateUrls) {
            try {
                const res = await fetch(url, {
                    method: "GET",
                    headers,
                    signal: AbortSignal.timeout(1000),
                });
                // Accept any response (including HTML SPAs) as proof the gateway is running.
                // Newer gateway versions serve an SPA on the same port as the WS endpoint,
                // so all HTTP GETs return text/html — but a 200 still proves the process is up.
                if (res.status >= 100 && res.status < 500) {
                    return true;
                }
            } catch {
                // continue polling
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return false;
}

export async function waitForGatewayWithUi(
    canRenderSpinner: boolean,
    gatewayPort: number,
    token: string,
    logFn: (level: "info" | "warn" | "error", msg: string) => void,
): Promise<void> {
    const readinessSpinner = canRenderSpinner ? spinner() : null;
    if (readinessSpinner) readinessSpinner.start(randomPhrase("gateway"));
    else logFn("info", "◌ Waiting for Gateway to initialize...");

    const gatewayReady = await waitForManagedGatewayReady(gatewayPort, token);
    if (!gatewayReady) {
        if (readinessSpinner) {
            readinessSpinner.stop("❌ Gateway did not become ready within 5 seconds.");
        }
        logger.plain(
            formatFlatError("GATEWAY STARTUP TIMEOUT", [
                `Gateway did not respond at port ${gatewayPort} or ${gatewayPort + 2} within 5 seconds.`,
                `Suggestion: Verify OpenClaw startup logs and confirm the gateway is running.`,
                "Suggestion: Run `teamclaw run openclaw` to verify the gateway starts cleanly.",
            ]),
        );
        process.exit(1);
    }

    if (readinessSpinner) readinessSpinner.stop("✅ Gateway initialization complete.");
    else logFn("info", "Gateway initialization complete.");
}

/**
 * Ensure gateway is running, starting a managed one if needed.
 * Returns true if gateway is ready, exits process on unrecoverable failure.
 */
export async function ensureGatewayRunning(
    config: GatewaySetupConfig,
    canRenderSpinner: boolean,
    logFn: (level: "info" | "warn" | "error", msg: string) => void,
): Promise<void> {
    // Mock LLM mode — skip gateway entirely
    const { isMockLlmEnabled } = await import("../core/mock-llm.js");
    if (isMockLlmEnabled()) {
        logFn("info", "[mock mode] Skipping gateway setup");
        return;
    }

    const gatewayAlreadyRunning = await isPortInUse(config.gatewayPort);

    if (config.managedGateway && gatewayAlreadyRunning) {
        logFn("info", `Gateway already running on port ${config.gatewayPort}. Attaching...`);
        setupGatewayCleanupHandlers();
        await waitForGatewayWithUi(canRenderSpinner, config.gatewayPort, config.token, logFn);
        return;
    }

    if (!gatewayAlreadyRunning) {
        if (config.managedGateway) {
            setupGatewayCleanupHandlers();
            const { startManagedGateway } = await import("../commands/run-openclaw.js");

            const gatewayState = await startManagedGateway(String(config.gatewayPort), { useSpinner: canRenderSpinner });

            if (!gatewayState.wasAlreadyRunning) {
                logFn("info", `Managed gateway started (PID: ${gatewayState.pid})`);
            }
            await waitForGatewayWithUi(canRenderSpinner, config.gatewayPort, config.token, logFn);
        } else {
            logger.plain(
                formatFlatError("EXTERNAL GATEWAY UNREACHABLE", [
                    `Cause: Connection refused at ${config.gatewayUrl}`,
                    "Suggestion: Run `teamclaw setup` to reconfigure your environment.",
                    "Suggestion: Run `teamclaw config` to edit gateway settings.",
                    "Suggestion: Run `teamclaw run openclaw` to start the gateway manually.",
                ]),
            );

            if (canRenderSpinner) {
                const recovery = await select({
                    message: "How would you like to recover?",
                    options: [
                        {
                            label: "🔄 Auto-Fix: Start OpenClaw gateway on configured port",
                            value: "start_gateway",
                        },
                        {
                            label: "⚙️  Reconfigure: Run `teamclaw setup` wizard",
                            value: "setup",
                        },
                        {
                            label: "🚪 Exit",
                            value: "exit",
                        },
                    ],
                });

                if (!isCancel(recovery)) {
                    if (recovery === "start_gateway") {
                        const { startOpenclawGateway } = await import("../commands/run-openclaw.js");
                        await startOpenclawGateway({ port: String(config.gatewayPort), skipPrompt: true });
                        logFn("warn", "Gateway started. Please retry `teamclaw work`.");
                    } else if (recovery === "setup") {
                        const { runSetup } = await import("../commands/setup.js");
                        await runSetup();
                        return;
                    }
                }
            }
            process.exit(1);
        }
    }
}

/**
 * Run gateway health check and handle fatal connectivity issues.
 * Returns true if healthy, exits process on fatal failure.
 */
export async function verifyGatewayHealth(
    config: GatewaySetupConfig,
    canRenderSpinner: boolean,
    logFn: (level: "info" | "warn" | "error", msg: string) => void,
): Promise<void> {
    // Mock LLM mode — skip health check
    const { isMockLlmEnabled: mockCheck } = await import("../core/mock-llm.js");
    if (mockCheck()) {
        logFn("info", "[mock mode] Skipping gateway health check");
        return;
    }

    const health = await runGatewayHealthCheck();
    const pingCheck = health.checks.find((c) => c.name === "ping");
    const authCheck = health.checks.find((c) => c.name === "auth");
    const pingPass = pingCheck?.level === "pass";
    const authPass = authCheck?.level === "pass";
    const fatalConnectivityIssue =
        !pingPass || (!authPass && health.authStatus === "invalid");

    if (!fatalConnectivityIssue) return;

    const gatewayAlreadyRunning = await isPortInUse(config.gatewayPort);
    const authFailed = health.authStatus === "invalid";
    const pingFailure = health.checks.find(
        (c) => c.name === "ping" && c.level === "fail",
    );
    const modelFailed = health.checks.find(
        (c) => c.name === "model" && c.level === "fail",
    );

    const diagLines: string[] = [];
    if (authFailed) {
        diagLines.push(
            "Cause: Gateway returned HTTP 401 or 403.",
            "Suggestion: Verify OPENCLAW_TOKEN or run `teamclaw setup`.",
        );
    } else if (pingFailure) {
        diagLines.push(
            `Cause: Connection refused at ${health.gatewayUrl}.`,
            `Detail: ${pingFailure.message}`,
            "Suggestion: Ensure the gateway process is running and reachable.",
        );
    }

    if (modelFailed && !authFailed && !pingFailure) {
        diagLines.push(
            `Detail: ${modelFailed.message}`,
            "Suggestion: Verify OPENCLAW_MODEL against the gateway model list.",
        );
    }

    diagLines.push(
        "Suggestion: Run `teamclaw setup` to reconfigure your environment.",
        "Suggestion: Run `teamclaw config` to edit individual settings.",
        "Suggestion: Run `teamclaw run openclaw` to restart the gateway.",
    );

    logger.plain(formatFlatError("GATEWAY CONNECTION FAILED", diagLines));

    if (health.tip) {
        logFn("warn", health.tip);
    }

    if (canRenderSpinner) {
        const recoveryOptions = gatewayAlreadyRunning
            ? [
                  {
                      label: "🔍 Re-detect Gateway (run setup)",
                      value: "redetect",
                  },
                  {
                      label: "⚙️  Check Config",
                      value: "check_config",
                  },
                  {
                      label: "🚪 Exit",
                      value: "exit",
                  },
              ]
            : [
                  {
                      label: "🔄 Auto-Fix: Start the OpenClaw gateway now",
                      value: "start_gateway",
                  },
                  {
                      label: "⚙️  Reconfigure: Run `teamclaw setup` wizard",
                      value: "setup",
                  },
                  {
                      label: "🚪 Exit",
                      value: "exit",
                  },
              ];

        const recovery = await select({
            message: "How would you like to recover?",
            options: recoveryOptions,
        });

        if (!isCancel(recovery)) {
            if (recovery === "start_gateway") {
                const portInUse = await isPortInUse(config.gatewayPort);
                if (portInUse) {
                    logFn("info", `Gateway already running on port ${config.gatewayPort}. Attaching...`);
                    await waitForGatewayWithUi(
                        canRenderSpinner,
                        config.gatewayPort,
                        config.token,
                        logFn,
                    );
                } else {
                    const { startOpenclawGateway } = await import("../commands/run-openclaw.js");
                    await startOpenclawGateway({ port: String(config.gatewayPort), skipPrompt: false });
                    logFn("warn", "Gateway started. Please retry `teamclaw work`.");
                }
            } else if (recovery === "redetect") {
                const { runSetup } = await import("../commands/setup.js");
                await runSetup();
                return;
            } else if (recovery === "check_config") {
                logger.plain(
                    formatFlatError("CURRENT GATEWAY CONFIG", [
                        `Gateway URL: ${config.gatewayUrl}`,
                        `API URL: ${config.apiUrl}`,
                        `Gateway Port: ${config.gatewayPort}`,
                        `Expected API Port: ${config.gatewayPort + 2}`,
                        `Managed Gateway: ${config.managedGateway ? "yes" : "no"}`,
                    ]),
                );
            } else if (recovery === "setup") {
                const { runSetup } = await import("../commands/setup.js");
                await runSetup();
                return;
            }
        }
    }
    process.exit(1);
}

/**
 * Handle fatal gateway errors during an active run with structured diagnostics.
 */
export async function handleRuntimeGatewayError(
    errMsg: string,
    gatewayUrl: string,
    canRenderSpinner: boolean,
): Promise<void> {
    const isAuthError = /HTTP 401|HTTP 403|Unauthorized/i.test(errMsg);
    const isGatewayDown =
        !isAuthError && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|WebSocket closed|fetch failed/i.test(errMsg);
    const isModelError =
        !isGatewayDown && !isAuthError && /HTTP 404|Not Found|model/i.test(errMsg);

    const diagLines: string[] = [];
    if (isGatewayDown) {
        diagLines.push(
            `Cause: Connection refused at ${gatewayUrl}.`,
            `Detail: ${errMsg.split("\n")[0] ?? errMsg}`,
            "Suggestion: Check gateway process health and port availability.",
        );
    } else if (isAuthError) {
        diagLines.push(
            "Cause: Gateway returned HTTP 401 or 403 mid-session.",
            "Suggestion: Verify OPENCLAW_TOKEN in your environment.",
        );
    } else if (isModelError) {
        diagLines.push(
            "Cause: Model not found (404) — possible model mismatch.",
            "Suggestion: Verify OPENCLAW_MODEL in your environment.",
        );
    } else {
        diagLines.push(
            `Cause: ${errMsg.split("\n")[0] ?? errMsg}`,
        );
    }
    diagLines.push(
        "Suggestion: Run `teamclaw setup` to reconfigure your environment.",
        "Suggestion: Run `teamclaw config` to edit individual settings.",
        "Suggestion: Run `teamclaw run openclaw` to restart the gateway.",
    );
    logger.plain(
        formatFlatError(
            "RUNTIME GATEWAY ERROR — WORK SESSION INTERRUPTED",
            diagLines,
        ),
    );

    if (canRenderSpinner) {
        const recovery = await select({
            message: "How would you like to recover?",
            options: [
                {
                    label: "🔄 Auto-Fix: Restart the OpenClaw gateway",
                    value: "restart_gateway",
                },
                {
                    label: "⚙️  Reconfigure: Run `teamclaw setup` wizard",
                    value: "setup",
                },
                {
                    label: "🚪 Exit",
                    value: "exit",
                },
            ],
        });

        if (!isCancel(recovery)) {
            if (recovery === "restart_gateway") {
                const { startOpenclawGateway } = await import("../commands/run-openclaw.js");
                await startOpenclawGateway({ skipPrompt: false });
                logger.warn("Gateway restarted. Please retry `teamclaw work`.");
            } else if (recovery === "setup") {
                const { runSetup } = await import("../commands/setup.js");
                await runSetup();
                return;
            }
        }
    }
}
