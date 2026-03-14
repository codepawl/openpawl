/**
 * Unified TeamClaw Setup Wizard — `teamclaw setup` / `teamclaw init`
 *
 * 6-step sequential wizard:
 *   Step 1: Connection  — auto-detect or prompt, verify with retry loop
 *   Step 2: Workspace   — choose workspace directory
 *   Step 3: Project     — name the project within the workspace
 *   Step 4: Model       — select from available models
 *   Step 5: Goal        — set the team's objective
 *   Step 6: Team        — pick a template or build custom roster
 *   Summary + Save
 */

import {
    confirm,
    intro,
    note,
    outro,
    select,
    spinner,
    text,
    cancel,
} from "@clack/prompts";
import pc from "picocolors";
import os from "node:os";
import path from "node:path";
import {
    readTeamclawConfig,
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
    readGlobalConfig,
    type TeamClawGlobalConfig,
} from "../core/global-config.js";
import { listAvailableModels } from "../core/model-config.js";
import { getDefaultGoal } from "../core/configManager.js";
import { writeConfig } from "../onboard/writeConfig.js";
import { promptPath } from "../utils/path-autocomplete.js";

import { handleCancel, stepConnection, type WizardState } from "./setup/connection.js";
import { stepGoal } from "./setup/goal-input.js";
import { stepTeam } from "./setup/team-builder.js";

// ---------------------------------------------------------------------------
// Step 2: Workspace
// ---------------------------------------------------------------------------

async function stepWorkspace(state: WizardState): Promise<void> {
    const localDefault = path.resolve("./teamclaw-workspace");
    const homeDefault = path.join(os.homedir(), ".teamclaw", "workspace");

    const globalConfig = readGlobalConfig();
    const tc = readTeamclawConfig();
    const projectWorkspace = (tc.data as Record<string, unknown>).workspace_dir as string | undefined;
    const lastUsedDir =
        globalConfig?.workspaceDir?.trim() ||
        projectWorkspace?.trim() ||
        null;
    const isLastUsedUnique =
        lastUsedDir &&
        lastUsedDir !== localDefault &&
        lastUsedDir !== homeDefault;

    let initialValue: string | undefined;
    if (isLastUsedUnique) {
        initialValue = "last";
    } else if (lastUsedDir === homeDefault) {
        initialValue = "home";
    } else if (lastUsedDir === localDefault) {
        initialValue = "local";
    }

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    if (isLastUsedUnique) {
        options.push({
            value: "last",
            label: `Last used (${pc.dim(lastUsedDir)})`,
            hint: "previous session",
        });
    }
    options.push(
        {
            value: "local",
            label: `Local directory (${pc.dim(localDefault)})`,
            hint: lastUsedDir === localDefault ? "previous session" : undefined,
        },
        {
            value: "home",
            label: `Home directory (${pc.dim(homeDefault)})`,
            hint: lastUsedDir === homeDefault ? "previous session" : undefined,
        },
        { value: "custom", label: "Custom path..." },
    );

    const choice = handleCancel(
        await select({
            message: "Where should TeamClaw store workspace files?",
            options,
            initialValue,
        }),
    ) as string;

    if (choice === "last") {
        state.workspaceDir = lastUsedDir!;
    } else if (choice === "local") {
        state.workspaceDir = localDefault;
    } else if (choice === "home") {
        state.workspaceDir = homeDefault;
    } else {
        const selected = await promptPath({
            message: "Select workspace directory",
            cwd: process.cwd(),
        });
        if (selected === null) {
            cancel("Setup cancelled.");
            process.exit(0);
        }
        state.workspaceDir = selected;
    }
}

// ---------------------------------------------------------------------------
// Step 3: Project Name
// ---------------------------------------------------------------------------

async function stepProject(state: WizardState): Promise<void> {
    const tc = readTeamclawConfig();
    const existingName = (tc.data as Record<string, unknown>).project_name as string | undefined;
    const dirName = path.basename(state.workspaceDir);
    const cwdName = path.basename(process.cwd());

    const detected = existingName?.trim() || dirName || cwdName || "";

    if (detected) {
        const choice = handleCancel(
            await select({
                message: "Project name:",
                options: [
                    {
                        value: detected,
                        label: `Use "${detected}"`,
                        hint: existingName ? "from config" : "from directory name",
                    },
                    { value: "__custom__", label: "Enter a different name..." },
                    { value: "__skip__", label: "Skip (no project name)" },
                ],
            }),
        ) as string;

        if (choice === "__skip__") {
            state.projectName = "";
            return;
        }

        if (choice !== "__custom__") {
            state.projectName = choice;
            return;
        }
    }

    const nameInput = handleCancel(
        await text({
            message: "Project name:",
            initialValue: "",
            placeholder: "my-awesome-project",
            validate: (v) =>
                (v ?? "").trim().length > 0 ? undefined : "Project name cannot be empty",
        }),
    ) as string;
    state.projectName = nameInput.trim();
}

// ---------------------------------------------------------------------------
// Step 4: Model
// ---------------------------------------------------------------------------

async function stepModel(state: WizardState): Promise<void> {
    const s = spinner();
    s.start("Fetching available models...");

    let models: string[] = [];
    try {
        models = await listAvailableModels();
    } catch {
        // ignore — will fall back to detected model or manual entry
    }

    s.stop(models.length > 0
        ? `Found ${models.length} available model(s)`
        : "No models discovered from gateway");

    if (models.length > 0) {
        const options: Array<{ value: string; label: string }> = models.map((m) => ({
            value: m,
            label: m,
        }));
        options.push({ value: "__custom", label: "Enter custom model..." });

        const picked = handleCancel(
            await select({
                message: "Select a model:",
                options,
                initialValue: state.detectedModel && models.includes(state.detectedModel)
                    ? state.detectedModel
                    : models[0],
            }),
        ) as string;

        if (picked === "__custom") {
            const custom = handleCancel(
                await text({
                    message: "Enter model name:",
                    placeholder: state.detectedModel ?? "gateway-default",
                    initialValue: state.detectedModel ?? "",
                }),
            ) as string;
            state.selectedModel = custom.trim() || "gateway-default";
        } else {
            state.selectedModel = picked;
        }
    } else if (state.detectedModel) {
        note(`Detected model from gateway: ${pc.cyan(state.detectedModel)}`, "Model");
        const useDetected = handleCancel(
            await confirm({
                message: `Use ${state.detectedModel}?`,
                initialValue: true,
            }),
        ) as boolean;

        if (useDetected) {
            state.selectedModel = state.detectedModel;
        } else {
            const custom = handleCancel(
                await text({
                    message: "Enter model name:",
                    placeholder: "gateway-default",
                }),
            ) as string;
            state.selectedModel = custom.trim() || "gateway-default";
        }
    } else {
        const custom = handleCancel(
            await text({
                message: "Enter model name (leave empty to let gateway decide):",
                placeholder: "gateway-default",
                initialValue: "",
            }),
        ) as string;
        state.selectedModel = custom.trim() || "gateway-default";
    }
}

// ---------------------------------------------------------------------------
// Persist all config
// ---------------------------------------------------------------------------

function persistAllConfig(state: WizardState): string {
    const wsUrl = `ws://${state.ip}:${state.port}`;
    const httpUrl = `http://${state.ip}:${state.apiPort}`;

    const globalConfig: TeamClawGlobalConfig = {
        version: 1,
        managedGateway: state.managed,
        gatewayHost: state.ip,
        gatewayPort: Number(state.port),
        apiPort: state.apiPort,
        gatewayUrl: wsUrl,
        apiUrl: httpUrl,
        token: state.token,
        model: state.selectedModel || "gateway-default",
        chatEndpoint: "/v1/chat/completions",
        dashboardPort: 9001,
        debugMode: false,
        workspaceDir: state.workspaceDir,
    };
    const globalConfigPath = writeGlobalConfig(globalConfig);

    writeConfig({
        workerUrl: wsUrl,
        authToken: state.token,
        roster: state.roster,
        goal: state.goal,
        model: state.selectedModel,
        chatEndpoint: "/v1/chat/completions",
        workspaceDir: state.workspaceDir,
        templateId: state.templateId,
        projectName: state.projectName,
    });

    setOpenClawWorkerUrl(wsUrl);
    setOpenClawHttpUrl(httpUrl);
    if (state.selectedModel) setOpenClawModel(state.selectedModel);
    setOpenClawToken(state.token);
    setOpenClawChatEndpoint("/v1/chat/completions");

    return globalConfigPath;
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

    const state: WizardState = {
        ip: "127.0.0.1",
        port: "18789",
        token: "",
        apiPort: 18791,
        detectedModel: null,
        workspaceDir: path.resolve("./teamclaw-workspace"),
        projectName: "",
        selectedModel: "",
        goal: getDefaultGoal(),
        roster: [],
        templateId: "",
        managed: true,
    };

    // Step 1/6: Connection
    note("Step 1/6", pc.bold("Connection"));
    await stepConnection(state);

    // Step 2/6: Workspace
    note("Step 2/6", pc.bold("Workspace"));
    await stepWorkspace(state);

    // Step 3/6: Project
    note("Step 3/6", pc.bold("Project"));
    await stepProject(state);

    // Step 4/6: Model
    note("Step 4/6", pc.bold("Model Selection"));
    await stepModel(state);

    // Step 5/6: Goal
    note("Step 5/6", pc.bold("Goal"));
    await stepGoal(state);

    // Step 6/6: Team
    note("Step 6/6", pc.bold("Team"));
    await stepTeam(state);

    // Summary
    const rosterSummary = state.roster.length > 0
        ? state.roster.map((r) => `${r.count}x ${r.role}`).join(", ")
        : "(none)";

    const maxVal = 50;
    const trunc = (s: string) => {
        const flat = s.replace(/\n/g, " ").trim();
        return flat.length > maxVal ? flat.slice(0, maxVal - 3) + "..." : flat;
    };

    note(
        [
            `Gateway   : ${trunc(`ws://${state.ip}:${state.port}`)}`,
            `API URL   : ${trunc(`http://${state.ip}:${state.apiPort}`)}`,
            `Token     : ${state.token ? "configured" : "none"}`,
            `Workspace : ${trunc(state.workspaceDir)}`,
            `Project   : ${state.projectName || "(none)"}`,
            `Model     : ${trunc(state.selectedModel || "gateway-default")}`,
            `Goal      : ${trunc(state.goal)}`,
            `Team      : ${trunc(rosterSummary)}`,
            `Template  : ${state.templateId || "custom"}`,
        ].join("\n"),
        "Configuration Summary",
    );

    const saveConfirm = handleCancel(
        await confirm({
            message: "Save this configuration?",
            initialValue: true,
        }),
    ) as boolean;

    if (!saveConfirm) {
        cancel("Setup cancelled — nothing was saved.");
        process.exit(0);
    }

    const globalConfigPath = persistAllConfig(state);

    note(
        [
            `Global config : ${pc.cyan(globalConfigPath)}`,
            `Project config: ${pc.cyan("teamclaw.config.json")}`,
        ].join("\n"),
        "Config saved!",
    );

    const nextStep = handleCancel(
        await select({
            message: "What would you like to do next?",
            options: [
                { value: "work", label: "Start a work session now  (teamclaw work)" },
                { value: "exit", label: "Exit" },
            ],
        }),
    ) as string;

    if (nextStep === "work") {
        outro("Launching work session...");
        const { runWork } = await import("../work-runner.js");
        await runWork({ args: [], noWeb: false });
    } else {
        outro(
            `Setup complete! Run ${pc.green("teamclaw work")} whenever you're ready.`,
        );
    }
}
