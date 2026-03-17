/**
 * Outcome reporting — run summaries, banners, formatting helpers.
 */

import pc from "picocolors";
import { logger } from "../core/logger.js";
import { getTrafficController } from "../core/traffic-control.js";
import { getLlmCache } from "../core/llm-cache.js";
import type { BotDefinition } from "../core/bot-definitions.js";

export function getBotName(botId: string, team: BotDefinition[]): string {
    const bot = team.find((b) => b.id === botId);
    return bot?.name ?? botId;
}

export function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

export function formatFlatError(title: string, lines: string[]): string {
    return [
        pc.red(`❌ ${title}`),
        ...lines.map((line) => pc.dim(`• ${line}`)),
        "",
    ].join("\n");
}

export function printRunBanner(
    runId: number,
    lessonsCount: number,
    totalRuns: number,
): void {
    logger.plain(
        [
            pc.cyan(`▶ START WORKING — RUN ${String(runId).padStart(2)}/${totalRuns}`),
            `• Prior run lessons: ${String(lessonsCount).padStart(2)}`,
        ].join("\n"),
    );
}

export function printSingleRunSummary(
    _goal: string,
    finalState: Record<string, unknown>,
    warnings: string[],
    team: BotDefinition[],
    workspacePath: string,
    startTime: number,
): void {
    const taskQueue = (finalState.task_queue ?? []) as Record<string, unknown>[];
    const cycleCount = (finalState.cycle_count as number) ?? 0;
    const botStats = (finalState.bot_stats as Record<string, Record<string, unknown>>) ?? {};

    const endTime = Date.now();
    const duration = endTime - startTime;

    const totalTasks = taskQueue.length;
    const completedTasks = taskQueue.filter((t) => t.status === "completed").length;
    const failedTasks = taskQueue.filter((t) => t.status === "failed").length;
    let totalReworks = 0;
    const contributions: string[] = [""];
    contributions.push(`  Total Tasks: ${totalTasks}`);

    for (const bot of team) {
        const stats = botStats[bot.id] ?? {};
        const completed = ((stats.tasks_completed as number) ?? 0);
        const failed = ((stats.tasks_failed as number) ?? 0);
        const reworks = ((stats.reworks_triggered as number) ?? 0);
        totalReworks += reworks;

        if (bot.role_id === "qa_reviewer") {
            contributions.push(`  ${bot.name}: ${reworks} reworks triggered`);
        } else if (completed > 0 || failed > 0) {
            contributions.push(`  ${bot.name}: ${completed} tasks completed, ${failed} failed`);
        }
    }

    const approvalRate = totalReworks + completedTasks > 0
        ? Math.round((completedTasks / (totalReworks + completedTasks)) * 100)
        : 100;

    let performanceVerdict = "";
    if (approvalRate >= 90) {
        performanceVerdict = "Team efficiency was excellent with minimal rework needed.";
    } else if (approvalRate >= 70) {
        performanceVerdict = "Team performed well with moderate rework.";
    } else if (approvalRate >= 50) {
        performanceVerdict = "Team had significant quality friction - consider clarifying requirements.";
    } else {
        performanceVerdict = "High rework rate detected - task definitions may need improvement.";
    }

    const lines: string[] = [
        "",
        pc.cyan("RUN SUMMARY"),
        `• Workspace: ${workspacePath}`,
        `• Duration: ${formatDuration(duration)}`,
        `• Cycles: ${cycleCount}`,
        "• Review Statistics:",
        `  - Tasks Completed: ${completedTasks}`,
        `  - Tasks Failed: ${failedTasks}`,
        `  - Total Reworks: ${totalReworks}`,
        `  - Approval Rate: ${approvalRate}%`,
        "• Individual Contributions:",
        ...contributions
            .filter((c) => c.trim().length > 0)
            .map((c) => `  - ${c.trim()}`),
        `• Performance Verdict: ${performanceVerdict}`,
    ];

    if (warnings.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        warnings.forEach((w) => lines.push(`  ⚠ ${w}`));
    }

    logger.plain(lines.join("\n"));
}

export function printWorkSummary(
    stats: {
        runs_completed: number;
        failures: number;
        longest_run_cycles: number;
        total_tasks_completed: number;
        total_lessons_learned: number;
    },
    lessons: string[],
): void {
    const trafficStats = getTrafficController().getStats();
    const oldest = lessons[0] ?? "(none)";
    const newest = lessons[lessons.length - 1] ?? "(none)";
    logger.plain(
        [
            pc.cyan("WORK SESSIONS COMPLETE"),
            `• Completed: ${stats.runs_completed}`,
            `• Failures: ${stats.failures}`,
            `• Successful: ${stats.runs_completed - stats.failures}`,
            `• Longest run: ${stats.longest_run_cycles} cycles`,
            `• Total tasks completed: ${stats.total_tasks_completed}`,
            `• API Requests Made: ${trafficStats.totalRequests}`,
            `• Lessons learned: ${stats.total_lessons_learned}`,
            `• Total lessons: ${lessons.length}`,
            "",
            pc.cyan("TRAFFIC CONTROL"),
            `• Max concurrent: ${trafficStats.maxRequests}`,
            `• Requests used: ${trafficStats.totalRequests}/${trafficStats.maxRequests}`,
            ...(() => {
                const cs = getLlmCache().getStats();
                const total = cs.hits + cs.misses;
                const hitRate = total > 0 ? Math.round((cs.hits / total) * 100) : 0;
                return [
                    "",
                    pc.cyan("LLM CACHE"),
                    `• Hits: ${cs.hits}`,
                    `• Misses: ${cs.misses}`,
                    `• Hit rate: ${hitRate}%`,
                    `• Estimated prompt chars saved: ${cs.estimatedSavedChars}`,
                ];
            })(),
            "",
            pc.cyan("LESSONS ACCUMULATED"),
            `• Oldest: "${oldest}"`,
            `• Newest: "${newest}"`,
        ].join("\n"),
    );
    lessons.forEach((l, i) => logger.plain(`  ${i + 1}. ${l}`));
    logger.plain([
        "",
        "History saved to:",
        "• ~/.teamclaw/logs/work-history-*.log",
        "• data/vector_store/",
        "",
    ].join("\n"));
}
