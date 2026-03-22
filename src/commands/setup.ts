/**
 * Unified TeamClaw Setup Wizard — `teamclaw setup` / `teamclaw init`
 *
 * 5-step sequential wizard:
 *   Step 1: Provider & Model — select LLM provider, API key, and model
 *   Step 2: Workspace        — choose workspace directory
 *   Step 3: Project          — name the project within the workspace
 *   Step 4: Goal             — set the team's objective
 *   Step 5: Team             — pick a template or build custom roster
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
import { searchableSelect, clampSelectOptions } from "../utils/searchable-select.js";
import pc from "picocolors";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
import type { CompositionWizardState } from "./setup/composition-mode.js";

import { PROVIDER_CATALOG } from "../providers/provider-catalog.js";

/** Get default model for a provider from the catalog */
function getDefaultModelForProvider(providerType: string): string {
    const meta = PROVIDER_CATALOG[providerType];
    return meta?.models[0]?.id ?? "";
}

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

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    if (isLastUsedUnique) {
        options.push({
            value: "last",
            label: `Last used (${pc.dim(lastUsedDir)})`,
            hint: "keeps files with your project",
        });
    }
    options.push(
        {
            value: "local",
            label: `Local directory (${pc.dim(localDefault)})`,
            hint: "keeps files with your project",
        },
        {
            value: "home",
            label: `Home directory (${pc.dim(homeDefault)})`,
            hint: "accessible from anywhere",
        },
        { value: "custom", label: "Choose a different folder..." },
    );

    const choice = handleCancel(
        await searchableSelect({
            message: "Where should TeamClaw keep your work?",
            options,
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
            cancel("Cancelled.");
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
            message: "What should we call this project?",
            initialValue,
            placeholder: "my-project",
            validate: (v) => {
                const trimmed = (v ?? "").trim();
                if (!trimmed) return "Project name cannot be empty";
                if (trimmed === workspaceDirName) {
                    return "Project name can't be the same as the workspace folder";
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
            message: `"${name}" already exists in this workspace. What would you like to do?`,
            options: clampSelectOptions([
                { value: "__rename__", label: "Choose a different name" },
                { value: "__suffix__", label: `Use "${autoName}" instead` },
                { value: "__custom_suffix__", label: "Enter a different name" },
                { value: "__use_anyway__", label: `Use "${name}" anyway`, hint: "⚠ will overwrite existing project" },
            ]),
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
    const existingProjects = listExistingProjects(state.workspaceDir);

    if (existingProjects.length === 0) {
        const cwdName = path.basename(process.cwd());
        const choice = handleCancel(
            await select({
                message: `No projects in ${pc.dim(state.workspaceDir)}. How would you like to start?`,
                options: clampSelectOptions([
                    { value: "__create__", label: "Create a new project folder" },
                    { value: "__use_cwd__", label: "Use current directory", hint: cwdName },
                    { value: "__back__", label: "Go back", hint: "change workspace" },
                ]),
            }),
        ) as string;

        if (choice === "__back__") {
            await stepWorkspace(state);
            await stepProject(state);
            return;
        }

        if (choice === "__use_cwd__") {
            state.projectName = cwdName;
            return;
        }

        // __create__
        await promptProjectName(state, "", existingProjects);
        return;
    }

    // Show existing projects to select from, plus create/back options
    const options: Array<{ value: string; label: string; hint?: string }> = existingProjects.map((proj) => ({
        value: proj,
        label: proj,
    }));

    options.push(
        { value: "__custom__", label: "Create new project" },
        { value: "__back__", label: "Go back", hint: "change workspace" },
    );

    const choice = handleCancel(
        await searchableSelect({
            message: "Select a project:",
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

    // User selected an existing project
    state.projectName = choice;
}

// ---------------------------------------------------------------------------
// Persist all config
// ---------------------------------------------------------------------------

function persistAllConfig(state: WizardState): string {
    // Create workspace and project directories if they don't exist
    if (state.workspaceDir && !existsSync(state.workspaceDir)) {
        mkdirSync(state.workspaceDir, { recursive: true });
    }
    if (state.workspaceDir && state.projectName) {
        const projectDir = path.join(state.workspaceDir, state.projectName);
        if (!existsSync(projectDir)) {
            mkdirSync(projectDir, { recursive: true });
        }
    }

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

    const existingConfig = readGlobalConfig();

    if (canTTY) {
        intro(pc.bold(pc.cyan("TeamClaw Setup")));

        if (existingConfig) {
            const existingModel = existingConfig.model ?? "";
            const existingProviders = (existingConfig.providers ?? []).map((p) => p.type).join(", ") || "none";
            note(
                [
                    `${pc.yellow("Existing configuration detected.")}`,
                    "",
                    `  Providers : ${existingProviders}`,
                    `  Model     : ${existingModel || "default"}`,
                    "",
                    "Running setup again will overwrite your current",
                    "provider, model, workspace, and team settings.",
                    "",
                    `Use ${pc.bold("teamclaw config")} to make targeted changes instead.`,
                ].join("\n"),
                "Re-configuring",
            );
            const proceed = handleCancel(
                await confirm({
                    message: "Continue and replace existing configuration?",
                    initialValue: false,
                }),
            );
            if (!proceed) {
                outro("Setup cancelled. Your existing configuration is unchanged.");
                return;
            }
        }

        note(
            [
                "Your AI team that never forgets.",
                "",
                "Takes about 2 minutes. You'll need an API key",
                "from your AI provider of choice.",
                "",
                "Steps:",
                `  ${pc.cyan("1.")} Choose AI provider   ${pc.dim("(~60 seconds)")}`,
                `  ${pc.cyan("2.")} Workspace & project  ${pc.dim("(~30 seconds)")}`,
                `  ${pc.cyan("3.")} Set the goal         ${pc.dim("(~15 seconds)")}`,
                `  ${pc.cyan("4.")} Pick a team          ${pc.dim("(~15 seconds)")}`,
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

    // Step 1/5: Providers (includes model selection)
    note("Step 1/5", pc.bold("Provider & Model"));
    await stepProvider(state);

    // Set selectedModel from first provider's model choice
    const firstProvider = state.providerEntries[0];
    state.selectedModel = firstProvider?.model || getDefaultModelForProvider(firstProvider?.type ?? "anthropic") || "default";

    // Step 2/5: Workspace
    note("Step 2/5", pc.bold("Workspace"));
    await stepWorkspace(state);

    // Ensure workspace directory exists so stepProject can list existing projects
    if (!existsSync(state.workspaceDir)) {
        mkdirSync(state.workspaceDir, { recursive: true });
    }

    // Step 3/5: Project
    note("Step 3/5", pc.bold("Project"));
    await stepProject(state);

    // Step 4/5: Goal (before team — team composition depends on the goal)
    note("Step 4/5", pc.bold("Your Goal"));
    await stepGoal(state);

    // Step 5/5: Team (composition mode is handled inside stepTeam)
    note("Step 5/5", pc.bold("Team"));
    await stepTeam(state);

    // Summary
    const rosterSummary = state.roster.length > 0
        ? state.roster.map((r) => `${r.count}x ${r.role}`).join(", ")
        : "(none)";

    const providerSummary = state.providerEntries
        .map((p, i) => {
            const name = p.name || p.type;
            const model = p.model || getDefaultModelForProvider(p.type) || "default";
            return `Provider ${i + 1}: ${name} (${model})`;
        })
        .join("\n            ");

    const maxVal = 50;
    const trunc = (s: string) => {
        const flat = s.replace(/\n/g, " ").trim();
        return flat.length > maxVal ? flat.slice(0, maxVal - 3) + "..." : flat;
    };

    const summaryLines = [
        `Providers : ${providerSummary}`,
        `Workspace : ${trunc(state.workspaceDir)}`,
        `Project   : ${state.projectName || "(none)"}`,
        `Model     : ${trunc(state.selectedModel || "default")}`,
        `Goal      : ${trunc(state.goal)}`,
        `Team      : ${trunc(rosterSummary)}`,
        `Template  : ${state.templateId || "custom"}`,
    ];
    // Only show Team Mode when it's not the default (autonomous)
    if (state.teamMode && state.teamMode !== "autonomous") {
        summaryLines.push(`Team Mode : ${state.teamMode}`);
    }

    note(summaryLines.join("\n"), "Configuration Summary");

    const saveConfirm = handleCancel(
        await confirm({
            message: "Save and continue?",
            initialValue: true,
        }),
    ) as boolean;

    if (!saveConfirm) {
        cancel("No worries — nothing was saved.");
        process.exit(0);
    }

    persistAllConfig(state);

    note(
        [
            `Provider:   ${providerSummary}`,
            `Team:       ${rosterSummary}`,
            `Model:      ${state.selectedModel || "default"}`,
            `Dashboard:  ${pc.green("http://localhost:9001")}`,
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
        "You're all set",
    );

    const nextStep = handleCancel(
        await select({
            message: "What would you like to do next?",
            options: clampSelectOptions([
                { value: "work", label: "Run my goal now" },
                { value: "demo", label: "Try a sample goal first" },
                { value: "exit", label: "Exit" },
            ]),
        }),
    ) as string;

    if (nextStep === "work") {
        outro("Starting your session...");
        const { runWork } = await import("../work-runner.js");
        await runWork({ args: [], noWeb: false });
    } else if (nextStep === "demo") {
        outro("Loading sample goal...");
        const { runDemo } = await import("./demo.js");
        await runDemo([]);
    } else {
        outro(
            `Done! Run ${pc.green("teamclaw work")} whenever you're ready.`,
        );
    }
}
