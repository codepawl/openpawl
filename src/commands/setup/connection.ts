/**
 * Setup Step 1: Gateway connection — auto-detect, prompt, verify.
 */

import {
    confirm,
    isCancel,
    cancel,
    select,
    spinner,
    text,
    password,
} from "@clack/prompts";
import pc from "picocolors";
import { readGlobalConfig } from "../../core/global-config.js";
import { readLocalOpenClawConfig } from "../../core/discovery.js";
import { randomPhrase } from "../../utils/spinner-phrases.js";

export interface WizardState {
    ip: string;
    port: string;
    token: string;
    apiPort: number;
    detectedModel: string | null;
    workspaceDir: string;
    projectName: string;
    selectedModel: string;
    goal: string;
    roster: import("../../core/team-templates.js").RosterEntry[];
    templateId: string;
    managed: boolean;
    teamMode?: string;
}

export function handleCancel<T>(v: T): T {
    if (isCancel(v)) {
        cancel("Setup cancelled.");
        process.exit(0);
    }
    return v;
}

function isLocalHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
}

async function pingGateway(
    ip: string,
    port: string,
    token: string,
): Promise<{ reachable: boolean; apiPort: number; model: string | null }> {
    const wsPort = parseInt(port, 10);

    // Prefer httpPort from the local OpenClaw config if available;
    // fall back to legacy wsPort + 2 convention.
    const openclawCfg = readLocalOpenClawConfig();
    const apiPort = openclawCfg?.httpPort && openclawCfg.httpPort !== wsPort + 2
        ? openclawCfg.httpPort
        : wsPort + 2;

    const headers: Record<string, string> = {};
    if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;

    const wsBase = `http://${ip}:${wsPort}`;
    let wsReachable = false;
    for (const p of ["/__openclaw__/api/config", "/api/status", "/"]) {
        try {
            const res = await fetch(`${wsBase}${p}`, {
                headers,
                signal: AbortSignal.timeout(3000),
            });
            wsReachable = true;
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
            const models = (data.data as Array<{ id?: string }> | undefined) ?? [];
            const firstModel = models.find(
                (m) => typeof m.id === "string" && m.id.trim().length > 0,
            )?.id;
            if (firstModel) return { reachable: true, apiPort, model: firstModel.trim() };

            const flatModel = data.model as string | undefined;
            if (typeof flatModel === "string" && flatModel.trim().length > 0)
                return { reachable: true, apiPort, model: flatModel.trim() };

            return { reachable: true, apiPort, model: null };
        } catch {
            // try next
        }
    }

    if (wsReachable) {
        return { reachable: true, apiPort, model: null };
    }

    return { reachable: false, apiPort, model: null };
}

async function promptConnectionDetails(
    state: WizardState,
    openclawConfig: ReturnType<typeof readLocalOpenClawConfig>,
): Promise<void> {
    const defaultPort = openclawConfig?.port?.toString() ?? "18789";
    const defaultIp = "127.0.0.1";

    const ipInput = handleCancel(
        await text({
            message: "Gateway IP / Hostname:",
            initialValue: defaultIp,
            placeholder: defaultIp,
            validate: (v) =>
                (v ?? "").trim().length > 0 ? undefined : "IP cannot be empty",
        }),
    ) as string;
    state.ip = ipInput.trim() || defaultIp;

    const portInput = handleCancel(
        await text({
            message: "Gateway Port:",
            initialValue: defaultPort,
            placeholder: defaultPort,
            validate: (v) => {
                const n = Number(v?.trim());
                return Number.isInteger(n) && n > 0 && n <= 65535
                    ? undefined
                    : "Port must be a number between 1 and 65535";
            },
        }),
    ) as string;
    state.port = portInput.trim() || defaultPort;

    const tokenInput = handleCancel(
        await password({
            message: "Gateway Auth Token (press Enter to skip if auth is disabled):",
        }),
    ) as string;
    state.token = (tokenInput ?? "").trim() || openclawConfig?.token || "";

    state.managed = isLocalHost(state.ip);
}

async function verifyConnection(state: WizardState): Promise<void> {
    while (true) {
        const s = spinner();
        s.start(randomPhrase("gateway"));

        const result = await pingGateway(state.ip, state.port, state.token);

        if (result.reachable) {
            state.apiPort = result.apiPort;
            state.detectedModel = result.model ?? null;
            const modelLabel = result.model ? ` (model: ${pc.cyan(result.model)})` : "";
            s.stop(`${pc.green("Gateway is reachable!")}${modelLabel}`);
            return;
        }

        s.stop(pc.yellow(`Could not reach gateway at ${state.ip}:${state.port}`));

        const action = handleCancel(
            await select({
                message: "What would you like to do?",
                options: [
                    { value: "retry", label: "Retry connection" },
                    { value: "edit", label: "Edit connection details" },
                    { value: "cancel", label: "Cancel setup" },
                ],
            }),
        ) as string;

        if (action === "cancel") {
            cancel("Setup cancelled.");
            process.exit(0);
        }

        if (action === "edit") {
            await promptConnectionDetails(state, readLocalOpenClawConfig());
        }
    }
}

export async function stepConnection(state: WizardState): Promise<void> {
    const openclawConfig = readLocalOpenClawConfig();
    const globalConfig = readGlobalConfig();

    const existingIp = globalConfig?.gatewayHost ?? openclawConfig?.port ? "127.0.0.1" : null;
    const existingPort = globalConfig?.gatewayPort?.toString()
        ?? openclawConfig?.port?.toString()
        ?? null;
    const existingToken = globalConfig?.token ?? openclawConfig?.token ?? "";

    if (existingPort) {
        const displayUrl = `ws://${existingIp ?? "127.0.0.1"}:${existingPort}`;
        const useExisting = handleCancel(
            await confirm({
                message: `Found OpenClaw at ${pc.cyan(displayUrl)}. Use this?`,
                initialValue: true,
            }),
        ) as boolean;

        if (useExisting) {
            state.ip = existingIp ?? "127.0.0.1";
            state.port = existingPort;
            state.token = existingToken;
            state.managed = globalConfig?.managedGateway ?? true;
        } else {
            await promptConnectionDetails(state, openclawConfig);
        }
    } else {
        await promptConnectionDetails(state, openclawConfig);
    }

    await verifyConnection(state);
}
