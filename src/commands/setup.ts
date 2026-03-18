/**
 * Unified TeamClaw Setup Wizard — `teamclaw setup` / `teamclaw init`
 *
 * 7-step sequential wizard:
 *   Step 1: Providers  — select LLM providers and API keys
 *   Step 2: Workspace  — choose workspace directory
 *   Step 3: Project    — name the project within the workspace
 *   Step 4: Model      — select model (defaults from provider)
 *   Step 5: Goal       — set the team's objective
 *   Step 6: Team       — pick a template or build custom roster
 *   Step 7: Composition Mode
 *   Summary + Save
 */

import {
    confirm,
    intro,
    note,
    outro,
    select,
    text,
    cancel,
} from "@clack/prompts";
import pc from "picocolors";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
    readTeamclawConfig,
} from "../core/jsonConfigManager.js";
import { logger } from "../core/logger.js";
import {
    writeGlobalConfig,
    readGlobalConfig,
    type TeamClawGlobalConfig,
} from "../core/global-config.js";
import { getDefaultGoal } from "../core/configManager.js";
import { writeConfig } from "../onboard/writeConfig.js";
import { promptPath } from "../utils/path-autocomplete.js";

import { handleCancel, stepProvider, type WizardState } from "./setup/connection.js";
import { stepGoal } from "./setup/goal-input.js";
import { stepTeam } from "./setup/team-builder.js";
import { stepCompositionMode } from "./setup/composition-mode.js";
import type { CompositionWizardState } from "./setup/composition-mode.js";

// Default models per provider type for the model selection step
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
    anthropic: "claude-sonnet-4-20250514",
    openai: "gpt-4o",
    openrouter: "anthropic/claude-sonnet-4-20250514",
    ollama: "llama3.1",
    deepseek: "deepseek-chat",
    groq: "llama-3.3-70b-versatile",
    custom: "",
};

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

function listExistingProjects(workspaceDir: string): string[] {
    const resolved = path.resolve(workspaceDir);
    if (!existsSync(resolved)) return [];
    try {
        return readdirSync(resolved)
            .filter((name) => {
                if (name.startsWith(".")) return false;
                try {
                    return statSync(path.join(resolved, name)).isDirectory();
                } catch {
                    return false;
                }
            });
    } catch {
        return [];
    }
}

async function promptProjectName(
    state: WizardState,
    initialValue: string,
    existingProjects: string[],
): Promise<void> {
    const workspaceDirName = path.basename(state.workspaceDir);

    const nameInput = handleCancel(
        await text({
            message: "Project name:",
            initialValue,
            placeholder: "my-awesome-project",
            validate: (v) => {
                const trimmed = (v ?? "").trim();
                if (!trimmed) return "Project name cannot be empty";
                if (trimmed === workspaceDirName) {
                    return `Name cannot match workspace directory ("${workspaceDirName}")`;
                }
                return undefined;
            },
        }),
    ) as string;

    const name = nameInput.trim();

    if (existingProjects.includes(name)) {
        await handleDuplicateProject(state, name, existingProjects);
    } else {
        state.projectName = name;
    }
}

async function handleDuplicateProject(
    state: WizardState,
    name: string,
    existingProjects: string[],
): Promise<void> {
    // Find a safe auto-suffix that doesn't conflict
    let suffix = 2;
    let autoName = `${name}-${suffix}`;
    while (existingProjects.includes(autoName)) {
        suffix++;
        autoName = `${name}-${suffix}`;
    }

    const resolution = handleCancel(
        await select({
            message: `Project "${name}" already exists in the workspace.`,
            options: [
                { value: "__rename__", label: "Choose a different name" },
                { value: "__suffix__", label: `Add suffix → "${autoName}"` },
                { value: "__custom_suffix__", label: "Add my own prefix/suffix" },
                { value: "__use_anyway__", label: `Use "${name}" anyway`, hint: "may overwrite" },
            ],
        }),
    ) as string;

    if (resolution === "__rename__") {
        await promptProjectName(state, "", existingProjects);
        return;
    }

    if (resolution === "__suffix__") {
        state.projectName = autoName;
        return;
    }

    if (resolution === "__custom_suffix__") {
        const custom = handleCancel(
            await text({
                message: `Enter the full project name (based on "${name}"):`,
                initialValue: name,
                placeholder: `${name}-v2`,
                validate: (v) => {
                    const trimmed = (v ?? "").trim();
                    if (!trimmed) return "Project name cannot be empty";
                    if (trimmed === name) return "Name is still the same — change it or pick another option";
                    return undefined;
                },
            }),
        ) as string;

        const customName = custom.trim();
        if (existingProjects.includes(customName)) {
            await handleDuplicateProject(state, customName, existingProjects);
        } else {
            state.projectName = customName;
        }
        return;
    }

    // __use_anyway__
    state.projectName = name;
}

async function stepProject(state: WizardState): Promise<void> {
    const tc = readTeamclawConfig();
    const existingName = (tc.data as Record<string, unknown>).project_name as string | undefined;
    const workspaceDirName = path.basename(state.workspaceDir);
    const existingProjects = listExistingProjects(state.workspaceDir);

    const options: Array<{ value: string; label: string; hint?: string }> = [];

    // Show previous project name if it's valid (not same as workspace dir)
    if (existingName?.trim() && existingName.trim() !== workspaceDirName) {
        options.push({
            value: existingName.trim(),
            label: `Use "${existingName.trim()}"`,
            hint: "from previous config",
        });
    }

    options.push(
        { value: "__custom__", label: "Enter a project name" },
        { value: "__back__", label: "Go back", hint: "return to workspace step" },
    );

    const choice = handleCancel(
        await select({
            message: "Project name:",
            options,
        }),
    ) as string;

    if (choice === "__back__") {
        await stepWorkspace(state);
        await stepProject(state);
        return;
    }

    if (choice === "__custom__") {
        await promptProjectName(state, "", existingProjects);
        return;
    }

    // User picked the previous config name — still check for duplicates
    if (existingProjects.includes(choice)) {
        await handleDuplicateProject(state, choice, existingProjects);
    } else {
        state.projectName = choice;
    }
}

// ---------------------------------------------------------------------------
// Step 4: Model Selection (simplified — defaults from first provider)
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS = [
    { value: "claude-sonnet-4-20250514", label: "claude-sonnet-4-6", hint: "Recommended · Fast + smart" },
    { value: "claude-opus-4-20250514", label: "claude-opus-4-6", hint: "Most capable · Slower" },
    { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5", hint: "Fastest · Lighter tasks" },
];

const OPENAI_MODELS = [
    { value: "gpt-4o", label: "gpt-4o", hint: "Recommended · Fast + smart" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini", hint: "Fastest · Lighter tasks" },
    { value: "o3", label: "o3", hint: "Most capable · Reasoning" },
];

async function stepModel(state: WizardState): Promise<void> {
    const firstProvider = state.providerEntries[0];
    const providerType = firstProvider?.type ?? "anthropic";
    const providerModel = firstProvider?.model;
    const defaultModel = providerModel || PROVIDER_DEFAULT_MODELS[providerType] || "";

    let modelOptions: Array<{ value: string; label: string; hint?: string }> | null = null;
    let defaultModelLabel = "";

    if (providerType === "anthropic") {
        modelOptions = ANTHROPIC_MODELS;
        defaultModelLabel = "claude-sonnet-4-6";
    } else if (providerType === "openai") {
        modelOptions = OPENAI_MODELS;
        defaultModelLabel = "gpt-4o";
    }

    if (modelOptions) {
        const options = [
            ...modelOptions,
            { value: "__custom__", label: "Other", hint: "Enter a model name manually" },
        ];

        console.log(`  ${pc.dim(`Tip: ${defaultModelLabel} is the best balance for most TeamClaw workflows.`)}`);

        const choice = handleCancel(
            await select({
                message: "Choose a model:",
                options,
            }),
        ) as string;

        if (choice === "__custom__") {
            const custom = handleCancel(
                await text({
                    message: "Enter model name:",
                    placeholder: defaultModel || "model-name",
                    initialValue: defaultModel,
                }),
            ) as string;
            state.selectedModel = custom.trim() || defaultModel || "default";
        } else {
            state.selectedModel = choice;
        }
    } else {
        if (defaultModel) {
            note(
                `Default model from ${providerType} provider: ${pc.cyan(defaultModel)}`,
                "Model",
            );
            const useDefault = handleCancel(
                await confirm({
                    message: `Use ${defaultModel}?`,
                    initialValue: true,
                }),
            ) as boolean;

            if (useDefault) {
                state.selectedModel = defaultModel;
                return;
            }
        }

        const custom = handleCancel(
            await text({
                message: "Enter model name:",
                placeholder: defaultModel || "model-name",
                initialValue: defaultModel,
            }),
        ) as string;
        state.selectedModel = custom.trim() || defaultModel || "default";
    }
}

// ---------------------------------------------------------------------------
// Persist all config
// ---------------------------------------------------------------------------

function persistAllConfig(state: WizardState): string {
    const globalConfig: TeamClawGlobalConfig = {
        version: 1,
        managedGateway: false,
        gatewayHost: "127.0.0.1",
        gatewayPort: 0,
        apiPort: 0,
        gatewayUrl: "",
        apiUrl: "",
        token: "",
        model: state.selectedModel || "default",
        chatEndpoint: "/v1/chat/completions",
        dashboardPort: 9001,
        debugMode: false,
        workspaceDir: state.workspaceDir,
        providers: state.providerEntries,
    };
    const globalConfigPath = writeGlobalConfig(globalConfig);

    writeConfig({
        workerUrl: "",
        authToken: "",
        roster: state.roster,
        goal: state.goal,
        model: state.selectedModel,
        chatEndpoint: "/v1/chat/completions",
        workspaceDir: state.workspaceDir,
        templateId: state.templateId,
        projectName: state.projectName,
        teamMode: state.teamMode as "manual" | "autonomous" | undefined,
    });

    return globalConfigPath;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
    const canTTY = Boolean(process.stdout.isTTY && process.stderr.isTTY);

    if (canTTY) {
        intro(pc.bold(pc.cyan("TeamClaw Setup Wizard")));

        note(
            [
                "TeamClaw gives you a team of specialized AI agents",
                "that work together to ship your goals — and remember",
                "everything across sessions.",
                "",
                "This setup takes about 2 minutes.",
                `You'll need: an API key from your chosen AI provider.`,
                "",
                "Steps:",
                `  ${pc.cyan("1.")} Workspace & project  ${pc.dim("(~30 seconds)")}`,
                `  ${pc.cyan("2.")} Choose AI provider   ${pc.dim("(~60 seconds)")}`,
                `  ${pc.cyan("3.")} Pick a team          ${pc.dim("(~30 seconds)")}`,
            ].join("\n"),
            "Welcome to TeamClaw",
        );
    } else {
        logger.info("TeamClaw Setup Wizard");
    }

    const state: CompositionWizardState = {
        providerEntries: [],
        workspaceDir: path.resolve("./teamclaw-workspace"),
        projectName: "",
        selectedModel: "",
        goal: getDefaultGoal(),
        roster: [],
        templateId: "",
    };

    // Step 1/7: Providers
    note("Step 1/7", pc.bold("Providers"));
    await stepProvider(state);

    // Step 2/7: Workspace
    note("Step 2/7", pc.bold("Workspace"));
    await stepWorkspace(state);

    // Step 3/7: Project
    note("Step 3/7", pc.bold("Project"));
    await stepProject(state);

    // Step 4/7: Model Selection
    note("Step 4/7", pc.bold("Model Selection"));
    await stepModel(state);

    // Step 5/7: Goal
    note("Step 5/7", pc.bold("Goal"));
    await stepGoal(state);

    // Step 6/7: Team
    note("Step 6/7", pc.bold("Team"));
    await stepTeam(state);

    // Step 7/7: Composition Mode
    note("Step 7/7", pc.bold("Composition Mode"));
    await stepCompositionMode(state);

    // Summary
    const rosterSummary = state.roster.length > 0
        ? state.roster.map((r) => `${r.count}x ${r.role}`).join(", ")
        : "(none)";

    const providerSummary = state.providerEntries
        .map((p, i) => {
            const name = p.name || p.type;
            const model = p.model || PROVIDER_DEFAULT_MODELS[p.type] || "default";
            return `Provider ${i + 1}: ${name} (${model})`;
        })
        .join("\n            ");

    const maxVal = 50;
    const trunc = (s: string) => {
        const flat = s.replace(/\n/g, " ").trim();
        return flat.length > maxVal ? flat.slice(0, maxVal - 3) + "..." : flat;
    };

    note(
        [
            `Providers : ${providerSummary}`,
            `Workspace : ${trunc(state.workspaceDir)}`,
            `Project   : ${state.projectName || "(none)"}`,
            `Model     : ${trunc(state.selectedModel || "default")}`,
            `Goal      : ${trunc(state.goal)}`,
            `Team      : ${trunc(rosterSummary)}`,
            `Template  : ${state.templateId || "custom"}`,
            `Team Mode : ${state.teamMode || "manual"}`,
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

    persistAllConfig(state);

    note(
        [
            `Provider:   ${providerSummary}`,
            `Team:       ${rosterSummary}`,
            `Model:      ${state.selectedModel || "default"}`,
            `Dashboard:  ${pc.cyan("http://localhost:9001")}`,
            "",
            `${pc.bold("What to do next:")}`,
            "",
            `${pc.green("\u2192")} Start your first sprint:`,
            `  ${pc.cyan('teamclaw work --goal "describe what you want to build"')}`,
            "",
            `${pc.green("\u2192")} See TeamClaw in action first:`,
            `  ${pc.cyan("teamclaw demo")}`,
            "",
            `${pc.green("\u2192")} Open the dashboard:`,
            `  ${pc.cyan("teamclaw web start")}`,
            "",
            `${pc.green("\u2192")} Browse team templates:`,
            `  ${pc.cyan("teamclaw templates browse")}`,
        ].join("\n"),
        "Setup complete!",
    );

    const nextStep = handleCancel(
        await select({
            message: "What would you like to do next?",
            options: [
                { value: "work", label: "Start a work session now  (teamclaw work)" },
                { value: "demo", label: "See TeamClaw in action  (teamclaw demo)" },
                { value: "exit", label: "Exit" },
            ],
        }),
    ) as string;

    if (nextStep === "work") {
        outro("Launching work session...");
        const { runWork } = await import("../work-runner.js");
        await runWork({ args: [], noWeb: false });
    } else if (nextStep === "demo") {
        outro("Launching demo...");
        const { runDemo } = await import("./demo.js");
        await runDemo([]);
    } else {
        outro(
            `Setup complete! Run ${pc.green("teamclaw work")} whenever you're ready.`,
        );
    }
}
