/**
 * Unified OpenPawl Setup Wizard — `openpawl setup` / `openpawl init`
 *
 * 3-step sequential wizard:
 *   Step 1: Project — name the project (defaults to cwd basename)
 *   Step 2: Goal    — set the team's objective
 *   Step 3: Team    — pick a template or build custom roster
 *   Summary + Save
 */

import {
    note,
    select,
    text,
} from "@clack/prompts";
import { clampSelectOptions } from "../utils/searchable-select.js";
import pc from "picocolors";
import path from "node:path";
import { getDefaultGoal } from "../core/configManager.js";
import { writeConfig } from "../onboard/writeConfig.js";

import { handleCancel, type WizardState } from "./setup/connection.js";
import { stepGoal } from "./setup/goal-input.js";
import { stepTeam } from "./setup/team-builder.js";
import type { CompositionWizardState } from "./setup/composition-mode.js";

// ---------------------------------------------------------------------------
// Step 2: Project Name (workspace = cwd, no separate workspace directory)
// ---------------------------------------------------------------------------


async function promptProjectName(
    state: WizardState,
    initialValue: string,
): Promise<void> {
    const nameInput = handleCancel(
        await text({
            message: "What should we call this project?",
            initialValue,
            placeholder: "my-project",
            validate: (v) => {
                const trimmed = (v ?? "").trim();
                if (!trimmed) return "Project name cannot be empty";
                return undefined;
            },
        }),
    ) as string;

    state.projectName = nameInput.trim();
}

async function stepProject(state: WizardState): Promise<void> {
    // Workspace = cwd. Project name defaults to directory basename.
    const cwdName = path.basename(process.cwd());
    const choice = handleCancel(
        await select({
            message: "Project name for this workspace:",
            options: clampSelectOptions([
                { value: "__use_cwd__", label: `Use "${cwdName}"`, hint: "current directory" },
                { value: "__custom__", label: "Enter a custom name" },
            ]),
        }),
    ) as string;

    if (choice === "__use_cwd__") {
        state.projectName = cwdName;
        return;
    }

    await promptProjectName(state, cwdName);
}

// ---------------------------------------------------------------------------
// Full setup steps (workspace, project, goal, team) — used by `openpawl setup --full`
// ---------------------------------------------------------------------------

export async function runFullSetupSteps(): Promise<void> {
    const state: CompositionWizardState = {
        providerEntries: [],
        projectName: "",
        selectedModel: "",
        goal: getDefaultGoal(),
        roster: [],
        templateId: "",
    };

    // Step 1: Project
    note("Step 1/3", pc.bold("Project"));
    await stepProject(state);

    // Step 2: Goal
    note("Step 2/3", pc.bold("Your Goal"));
    await stepGoal(state);

    // Step 3: Team
    note("Step 3/3", pc.bold("Team"));
    await stepTeam(state);

    // Persist project-level config
    writeConfig({
        workerUrl: "",
        authToken: "",
        roster: state.roster,
        goal: state.goal,
        model: state.selectedModel,
        chatEndpoint: "/v1/chat/completions",
        templateId: state.templateId,
        projectName: state.projectName,
        teamMode: state.teamMode as "manual" | "autonomous" | undefined,
    });
}
