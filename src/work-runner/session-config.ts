/**
 * Session configuration — CLI arg parsing, session mode prompts, pre-launch confirmation.
 */

import { select, text, cancel, isCancel } from "@clack/prompts";
import pc from "picocolors";
import { logger } from "../core/logger.js";
import { promptPath } from "../utils/path-autocomplete.js";

export type ParsedWorkArgs = {
    maxRuns: number;
    timeoutMinutes: number | undefined;
    sessionMode: "runs" | "time" | undefined;
    clearLegacy: boolean;
    autoApprove: boolean;
    noWebFlag: boolean;
    noPreview: boolean;
    asyncMode: boolean;
    asyncTimeout: number;
    teamMode: "manual" | "autonomous" | undefined;
};

export function parseWorkArgs(args: string[]): ParsedWorkArgs {
    let maxRuns = 1;
    let timeoutMinutes: number | undefined = undefined;
    let sessionMode: "runs" | "time" | undefined = undefined;
    let clearLegacy = false;
    let autoApprove = false;
    let noWebFlag = false;
    let noPreview = false;
    let asyncMode = false;
    let asyncTimeout = 0;
    let teamMode: "manual" | "autonomous" | undefined = undefined;
    let warnedInfraFlag = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--runs" && args[i + 1]) {
            maxRuns = Math.max(1, parseInt(args[i + 1], 10) || 1);
            sessionMode = "runs";
            i++;
        } else if (args[i] === "--generations" && args[i + 1]) {
            maxRuns = Math.max(1, parseInt(args[i + 1], 10) || 1);
            sessionMode = "runs";
            i++;
        } else if (args[i] === "--timeout" && args[i + 1]) {
            timeoutMinutes = Math.max(1, parseInt(args[i + 1], 10) || 30);
            sessionMode = "time";
            i++;
        } else if (args[i]?.startsWith("--timeout=")) {
            const val = args[i]?.replace("--timeout=", "");
            timeoutMinutes = Math.max(1, parseInt(val, 10) || 30);
            sessionMode = "time";
        } else if (args[i] === "--clear-legacy") {
            clearLegacy = true;
        } else if (args[i] === "--auto-approve") {
            autoApprove = true;
        } else if (args[i] === "--no-web") {
            noWebFlag = true;
        } else if (args[i] === "--no-preview") {
            noPreview = true;
        } else if (args[i] === "--async") {
            asyncMode = true;
        } else if (args[i] === "--team" && args[i + 1]) {
            const val = args[i + 1];
            if (val === "manual" || val === "autonomous") {
                teamMode = val;
            }
            i++;
        } else if (args[i] === "--async-timeout" && args[i + 1]) {
            asyncTimeout = Math.max(1, parseInt(args[i + 1], 10) || 5);
            i++;
        } else if (
            args[i] === "--discover" ||
            args[i] === "--no-managed-gateway" ||
            args[i] === "--port" ||
            args[i] === "-p" ||
            args[i]?.startsWith("--port=")
        ) {
            if (!warnedInfraFlag) {
                logger.warn(
                    "Ignoring infrastructure override flags for `teamclaw work` (Pillar 2 zero-config). Run `teamclaw setup` or `teamclaw config` instead.",
                );
                warnedInfraFlag = true;
            }
            if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) i++;
        }
    }

    return { maxRuns, timeoutMinutes, sessionMode, clearLegacy, autoApprove, noWebFlag, noPreview, asyncMode, asyncTimeout, teamMode };
}

export async function promptSessionConfig(
    canRenderSpinner: boolean,
    parsed: ParsedWorkArgs,
): Promise<{ maxRuns: number; timeoutMinutes: number; sessionMode: "runs" | "time" }> {
    let { maxRuns, timeoutMinutes, sessionMode } = parsed;
    const DEFAULT_MAX_RUNS = 3;
    const DEFAULT_TIMEOUT_MINUTES = 30;

    if (canRenderSpinner && sessionMode === undefined) {
        const modeInput = await select({
            message: "How should the session end?",
            options: [
                { label: "After a set number of runs (Recommended)", value: "runs" as const },
                { label: "After a time limit", value: "time" as const },
            ],
        });

        if (!isCancel(modeInput)) {
            sessionMode = modeInput as "runs" | "time";
        }

        if (sessionMode === "runs") {
            const runsInput = await select({
                message: "How many runs should the team do?",
                options: [
                    { label: "1 run", value: 1 },
                    { label: "3 runs (Recommended)", value: 3 },
                    { label: "5 runs", value: 5 },
                    { label: "10 runs", value: 10 },
                ],
            });
            if (!isCancel(runsInput)) {
                maxRuns = runsInput as number;
            }
        } else if (sessionMode === "time") {
            const timeoutInput = await select({
                message: "How long should the session last?",
                options: [
                    { label: "15 minutes", value: 15 },
                    { label: "30 minutes (Recommended)", value: 30 },
                    { label: "60 minutes", value: 60 },
                    { label: "120 minutes", value: 120 },
                ],
            });
            if (!isCancel(timeoutInput)) {
                timeoutMinutes = timeoutInput as number;
            }
        }
    }

    if (sessionMode === undefined) sessionMode = "runs";
    if (sessionMode === "runs") {
        if (maxRuns === undefined || maxRuns === 1) maxRuns = DEFAULT_MAX_RUNS;
        timeoutMinutes = 0;
    } else {
        if (timeoutMinutes === undefined) timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
        maxRuns = 999;
    }

    return { maxRuns, timeoutMinutes: timeoutMinutes ?? 0, sessionMode };
}

export async function promptPreLaunchConfirmation(
    canRenderSpinner: boolean,
    effectiveGoal: string,
    workspacePath: string,
    sessionMode: "runs" | "time",
    maxRuns: number,
    timeoutMinutes: number,
    model: string,
): Promise<{ goal: string; workspace: string; maxRuns: number; timeoutMinutes: number; sessionMode: "runs" | "time" }> {
    let goal = effectiveGoal;
    let workspace = workspacePath;

    const goalFlat = goal.replace(/\n/g, " ").trim();
    const firstLine = goalFlat.replace(/^#\s*/, "").split(/\.\s|;\s/)[0].trim();
    const goalShort = firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;

    logger.plain("");
    logger.plain(pc.dim("  Goal      ") + goalShort);
    logger.plain(pc.dim("  Workspace ") + workspace);
    const sessionLabel = sessionMode === "time"
        ? `${timeoutMinutes}min (time limit)`
        : `${maxRuns} runs`;
    logger.plain(pc.dim("  Session   ") + sessionLabel);
    logger.plain(pc.dim("  Model     ") + model);
    logger.plain("");

    const action = await select({
        message: "Ready to start?",
        options: [
            { value: "start", label: "Start session" },
            { value: "edit_goal", label: "Edit goal" },
            { value: "edit_workspace", label: "Change workspace" },
            { value: "edit_runs", label: "Change session limit" },
            { value: "cancel", label: "Cancel" },
        ],
    });

    if (isCancel(action) || action === "cancel") {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (action === "edit_goal") {
        const newGoal = await text({
            message: "Enter your goal:",
            initialValue: goal,
            placeholder: "Build a landing page with authentication",
        });
        if (isCancel(newGoal) || !String(newGoal).trim()) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        goal = String(newGoal).trim();
    }

    if (action === "edit_workspace") {
        const selectedPath = await promptPath({
            message: "Select workspace directory:",
            cwd: workspace,
        });
        if (selectedPath === null) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        workspace = selectedPath;
    }

    if (action === "edit_runs") {
        const modeInput = await select({
            message: "How should the session end?",
            options: [
                { label: "After a set number of runs", value: "runs" as const },
                { label: "After a time limit", value: "time" as const },
            ],
            initialValue: sessionMode,
        });
        if (!isCancel(modeInput)) sessionMode = modeInput as "runs" | "time";

        if (sessionMode === "runs") {
            const runsInput = await select({
                message: "How many runs?",
                options: [
                    { label: "1 run", value: 1 },
                    { label: "3 runs", value: 3 },
                    { label: "5 runs", value: 5 },
                    { label: "10 runs", value: 10 },
                ],
                initialValue: maxRuns,
            });
            if (!isCancel(runsInput)) maxRuns = runsInput as number;
            timeoutMinutes = 0;
        } else {
            const timeoutInput = await select({
                message: "How long should the session last?",
                options: [
                    { label: "15 minutes", value: 15 },
                    { label: "30 minutes", value: 30 },
                    { label: "60 minutes", value: 60 },
                    { label: "120 minutes", value: 120 },
                ],
                initialValue: timeoutMinutes,
            });
            if (!isCancel(timeoutInput)) timeoutMinutes = timeoutInput as number;
            maxRuns = 999;
        }
    }

    return { goal, workspace, maxRuns, timeoutMinutes, sessionMode };
}
