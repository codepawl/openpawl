/**
 * Interactive config validation and prompting — extracted from config.ts.
 * Handles discovery, inline prompts for missing values, and persistence.
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
import { randomPhrase } from "../utils/spinner-phrases.js";
import { setConfigAgentModels } from "./model-config.js";
import {
    CONFIG,
    setOpenClawWorkerUrl as applyWorkerUrl,
    setOpenClawHttpUrl as applyHttpUrl,
    setOpenClawToken as applyToken,
    setOpenClawChatEndpoint as applyChatEndpoint,
    setOpenClawModel as applyModel,
} from "./config.js";

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

function persistToProjectConfig(url: string, chatEndpoint: string, model: string): void {
    const tc = readTeamclawConfig();
    const persisted = { ...tc.data } as Record<string, unknown>;
    let changed = false;
    if (url && persisted["worker_url"] !== url) {
        persisted["worker_url"] = url;
        changed = true;
    }
    if (chatEndpoint && persisted["openclaw_chat_endpoint"] !== chatEndpoint) {
        persisted["openclaw_chat_endpoint"] = chatEndpoint;
        changed = true;
    }
    if (model && persisted["openclaw_model"] !== model) {
        persisted["openclaw_model"] = model;
        changed = true;
    }
    if (changed) {
        writeTeamclawConfig(tc.path, persisted);
        clearTeamConfigCache();
    }
}

function applyAllRuntime(values: {
    url?: string;
    httpUrl?: string;
    token?: string;
    chatEndpoint?: string;
    model?: string;
}): void {
    if (values.url) applyWorkerUrl(values.url);
    if (values.httpUrl) applyHttpUrl(values.httpUrl);
    if (values.token) applyToken(values.token);
    if (values.chatEndpoint) applyChatEndpoint(values.chatEndpoint);
    if (values.model) applyModel(values.model);
}

export async function validateOrPromptConfig(
    opts: { forceDiscover?: boolean } = {},
): Promise<void> {
    const teamCfg = await loadTeamConfig();
    const rosterOk = hasValidRoster(teamCfg);

    if (teamCfg?.agent_models && Object.keys(teamCfg.agent_models).length > 0) {
        setConfigAgentModels(teamCfg.agent_models);
    }

    const openclawUrl = CONFIG.openclawWorkerUrl ||
        (teamCfg?.worker_url ?? "").trim();
    const openclawToken =
        CONFIG.openclawToken ||
        (teamCfg?.openclaw_token ?? "").trim();
    const openclawChatEndpoint =
        CONFIG.openclawChatEndpoint ||
        (teamCfg?.openclaw_chat_endpoint ?? "").trim();
    const openclawModel =
        CONFIG.openclawModel ||
        (teamCfg?.openclaw_model ?? "").trim() ||
        "gateway-default";

    let effectiveOpenclawUrl = openclawUrl;
    let effectiveOpenclawToken = openclawToken;
    let effectiveOpenclawChatEndpoint = openclawChatEndpoint;
    let effectiveOpenclawModel = openclawModel;
    let discoveredModels: string[] = [];
    let localConfigAuthNotRequired = false;
    let configDirty = false;

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
            if (!earlyLocalCfg.authRequired) {
                localConfigAuthNotRequired = true;
            }
            if (!effectiveOpenclawUrl) {
                effectiveOpenclawUrl = earlyLocalCfg.url;
                configDirty = true;
            }
            applyHttpUrl(earlyLocalCfg.httpUrl);
            if (!effectiveOpenclawToken) {
                effectiveOpenclawToken = earlyLocalCfg.token;
                configDirty = true;
            }
            if (!effectiveOpenclawChatEndpoint) {
                effectiveOpenclawChatEndpoint = "/v1/chat/completions";
                configDirty = true;
            }
            if (earlyLocalCfg.model) {
                effectiveOpenclawModel = earlyLocalCfg.model;
                configDirty = true;
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
        applyAllRuntime({
            url: effectiveOpenclawUrl,
            token: effectiveOpenclawToken,
            chatEndpoint: effectiveOpenclawChatEndpoint,
            model: effectiveOpenclawModel,
        });
        if (configDirty) {
            persistToProjectConfig(effectiveOpenclawUrl, effectiveOpenclawChatEndpoint, effectiveOpenclawModel);
        }
        return;
    }

    const tc = readTeamclawConfig();
    const configEmpty = Object.keys(tc.data).length === 0;

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
        const { runSetup } = await import("../commands/setup.js");
        await runSetup();
        clearTeamConfigCache();
        return;
    }

    if (!effectiveOpenclawUrl || opts.forceDiscover) {
        const s = spinner();
        s.start(randomPhrase("scan"));

        const localCfg = opts.forceDiscover ? null : readLocalOpenClawConfig();

        if (localCfg) {
            if (!localCfg.authRequired) {
                localConfigAuthNotRequired = true;
            }
            effectiveOpenclawUrl = localCfg.url;
            effectiveOpenclawToken = localCfg.token;
            if (localCfg.model && !effectiveOpenclawModel) {
                effectiveOpenclawModel = localCfg.model;
            }
            if (!effectiveOpenclawChatEndpoint) {
                effectiveOpenclawChatEndpoint = "/v1/chat/completions";
            }

            applyAllRuntime({
                url: effectiveOpenclawUrl,
                httpUrl: localCfg.httpUrl,
                token: effectiveOpenclawToken,
                chatEndpoint: effectiveOpenclawChatEndpoint,
                model: effectiveOpenclawModel,
            });

            const modelLabel = localCfg.model
                ? `, model: ${localCfg.model}`
                : "";
            s.stop(
                `✅ [Config File] Found OpenClaw configuration! (Port: ${localCfg.port}${modelLabel})`,
            );
        } else {
            s.start(randomPhrase("scan"));
            const discovered = await discoverOpenAIApi("http://localhost", {
                preferredPort: parsePortFromUrl(effectiveOpenclawUrl),
                timeoutMs: 1000,
            });
            if (discovered.length > 0) {
                let selected = discovered[0]!;
                if (discovered.length > 1) {
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
                    s.stop(
                        `✅ Found ${selected.serviceName} at port ${selected.port} (${selected.protocol.toUpperCase()})`,
                    );
                }
                discoveredModels =
                    selected.protocol === "http" ? selected.models : [];
                if (!effectiveOpenclawUrl || opts.forceDiscover) {
                    effectiveOpenclawUrl = selected.baseUrl;
                    applyWorkerUrl(effectiveOpenclawUrl);
                }
                if (
                    !effectiveOpenclawChatEndpoint &&
                    selected.protocol === "http"
                ) {
                    effectiveOpenclawChatEndpoint = selected.chatEndpoint;
                    applyChatEndpoint(effectiveOpenclawChatEndpoint);
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

    if (!effectiveOpenclawUrl) {
        const url = handleInlineCancel(
            await text({
                message:
                    "Missing OpenClaw Gateway URL. Please enter it:",
                placeholder: "http://localhost:8001",
                validate: (v) =>
                    (v ?? "").trim().length > 0
                        ? undefined
                        : "URL cannot be empty",
            }),
        ) as string;
        const value = url.trim();
        if (value) {
            effectiveOpenclawUrl = value;
            applyWorkerUrl(value);
        }
    }

    if (!effectiveOpenclawToken && !localConfigAuthNotRequired) {
        const token = handleInlineCancel(
            await password({
                message:
                    "Missing OpenClaw token. Please enter it:",
                validate: (v) =>
                    (v ?? "").trim().length > 0
                        ? undefined
                        : "Token cannot be empty",
            }),
        ) as string;
        const value = token.trim();
        if (value) {
            effectiveOpenclawToken = value;
            applyToken(value);
        }
    }

    if (!effectiveOpenclawChatEndpoint) {
        const endpoint = handleInlineCancel(
            await text({
                message:
                    "Missing OpenClaw chat endpoint. Please enter it:",
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
            effectiveOpenclawChatEndpoint = value;
            applyChatEndpoint(value);
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
        const value = (discovered ?? "gateway-default").trim();
        effectiveOpenclawModel = value;
        applyModel(value);
    }

    applyAllRuntime({
        url: effectiveOpenclawUrl,
        token: effectiveOpenclawToken,
        chatEndpoint: effectiveOpenclawChatEndpoint,
        model: effectiveOpenclawModel,
    });

    persistToProjectConfig(effectiveOpenclawUrl, effectiveOpenclawChatEndpoint, effectiveOpenclawModel);

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
