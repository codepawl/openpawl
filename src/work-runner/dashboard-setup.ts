/**
 * Dashboard auto-start, health verification, and bridge initialization.
 */

import { logger } from "../core/logger.js";

export type DashboardSetupOptions = {
    webPort: number;
    dashboardPort?: number;
};

/**
 * Start the dashboard daemon, verify health, and initialize the bridge.
 * Returns the actual port the dashboard is serving on.
 */
export async function startDashboard(
    opts: DashboardSetupOptions,
): Promise<number> {
    const { start: startDaemon, stop: stopDaemon, status: daemonStatus } = await import("../daemon/manager.js");
    const webPort = opts.webPort;

    // Restart daemon if already running so it serves the latest build
    const preStatus = daemonStatus();
    if (preStatus.web === "running") {
        stopDaemon();
        await new Promise((r) => setTimeout(r, 500));
    }

    const daemonResult = startDaemon({ web: true, gateway: false, webPort });
    const actualStatus = daemonStatus();
    const actualPort = actualStatus.webPort || webPort;
    if (!daemonResult.error) {
        const dashboardUrl = `http://localhost:${actualPort}`;
        logger.plain("");
        logger.plain(`>>> TeamClaw Dashboard: ${dashboardUrl}`);
        logger.plain("");

        // Auto-open dashboard in browser
        try {
            // @ts-expect-error — optional peer dependency, may not be installed
            const { default: open } = await import("open");
            await open(dashboardUrl);
        } catch {
            // Ignore - non-critical
        }
    } else {
        logger.warn(`Dashboard auto-start skipped: ${daemonResult.error}`);
    }

    // Verify dashboard is serving correctly (retry up to 3s for server startup)
    let dashboardHealthy = false;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const checkUrl = `http://localhost:${actualPort}`;
            const res = await fetch(checkUrl, { signal: AbortSignal.timeout(2000) });
            const contentType = res.headers.get("content-type") ?? "";
            const body = await res.text();
            const hasHtml = contentType.includes("text/html") && body.includes("<script");
            if (res.ok && hasHtml) {
                logger.success(`>>> Dashboard Health: OK (HTTP ${res.status}, ${(body.length / 1024).toFixed(1)}KB HTML)`);
                dashboardHealthy = true;
            } else {
                logger.warn(`>>> Dashboard Health: unexpected response (HTTP ${res.status}, content-type: ${contentType})`);
            }
            break;
        } catch {
            if (attempt < 5) {
                await new Promise((r) => setTimeout(r, 500));
            } else {
                logger.warn(`>>> Dashboard Health: unreachable after ${(attempt + 1) * 500}ms — server may still be starting`);
            }
        }
    }

    // Verify SSE endpoint (only if HTTP health passed)
    if (dashboardHealthy) {
        try {
            const sseCheckUrl = `http://localhost:${actualPort}/api/config`;
            const sseRes = await fetch(sseCheckUrl, { signal: AbortSignal.timeout(3000) });
            if (sseRes.ok) {
                logger.success(`>>> Dashboard SSE: OK (API reachable)`);
            } else {
                logger.warn(`>>> Dashboard SSE: unexpected status ${sseRes.status}`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`>>> Dashboard SSE: check failed — ${msg}`);
        }
    }

    // Initialize dashboard bridge to forward orchestration events + terminal output
    try {
        const { initDashboardBridge, getDashboardBridge } = await import("../core/dashboard-bridge.js");
        const bridgeOk = await initDashboardBridge(actualPort);
        if (bridgeOk) {
            logger.success(">>> Dashboard Bridge: CONNECTED");
            getDashboardBridge().startTerminalForwarding();
        } else {
            logger.warn(">>> Dashboard Bridge: connection failed — dashboard may not update in real-time.");
        }
    } catch {
        logger.warn(">>> Dashboard Bridge: init failed.");
    }

    return actualPort;
}
