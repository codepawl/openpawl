/**
 * Unified OpenPawl Setup Wizard — `openpawl setup` / `openpawl init`
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
    note,
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
    readOpenpawlConfig,
} from "../core/jsonConfigManager.js";
import {
    readGlobalConfig,
} from "../core/global-config.js";
import { getDefaultGoal } from "../core/configManager.js";
import { writeConfig } from "../onboard/writeConfig.js";
import { promptPath } from "../utils/path-autocomplete.js";

import { handleCancel, type WizardState } from "./setup/connection.js";
import { stepGoal } from "./setup/goal-input.js";
import { stepTeam } from "./setup/team-builder.js";
import type { CompositionWizardState } from "./setup/composition-mode.js";

// ---------------------------------------------------------------------------
// Step 2: Workspace
// ---------------------------------------------------------------------------

async function stepWorkspace(state: WizardState): Promise<void> {
    const localDefault = path.resolve("./openpawl-workspace");
    const homeDefault = path.join(os.homedir(), ".openpawl", "workspace");

    const globalConfig = readGlobalConfig();
    const tc = readOpenpawlConfig();
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
            message: "Where should OpenPawl keep your work?",
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
// Full setup steps (workspace, project, goal, team) — used by `openpawl setup --full`
// ---------------------------------------------------------------------------

export async function runFullSetupSteps(): Promise<void> {
    const state: CompositionWizardState = {
        providerEntries: [],
        workspaceDir: path.resolve("./openpawl-workspace"),
        projectName: "",
        selectedModel: "",
        goal: getDefaultGoal(),
        roster: [],
        templateId: "",
    };

    // Step 1: Workspace
    note("Step 1/4", pc.bold("Workspace"));
    await stepWorkspace(state);

    // Ensure workspace directory exists so stepProject can list existing projects
    if (!existsSync(state.workspaceDir)) {
        mkdirSync(state.workspaceDir, { recursive: true });
    }

    // Step 2: Project
    note("Step 2/4", pc.bold("Project"));
    await stepProject(state);

    // Step 3: Goal
    note("Step 3/4", pc.bold("Your Goal"));
    await stepGoal(state);

    // Step 4: Team
    note("Step 4/4", pc.bold("Team"));
    await stepTeam(state);

    // Persist project-level config
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
}
