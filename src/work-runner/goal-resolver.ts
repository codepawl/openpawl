/**
 * Goal resolution — file-based goals, AI suggestions, workspace content checks.
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { log as clackLog, note, spinner, select, text, cancel, isCancel } from "@clack/prompts";
import { randomPhrase } from "../utils/spinner-phrases.js";
import { logger } from "../core/logger.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";
import pc from "picocolors";
import { VectorMemory } from "../core/knowledge-base.js";
import { CONFIG } from "../core/config.js";
import { UserCancelError } from "./types.js";

export const WORKSPACE_PROTECTED = new Set([".git", "teamclaw.config.json"]);

/** Word-wrap text to a max column width, breaking on spaces. */
export function wrapText(text: string, maxWidth = 80): string {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        if (paragraph.length <= maxWidth) {
            lines.push(paragraph);
            continue;
        }
        let line = "";
        for (const word of paragraph.split(" ")) {
            if (line && line.length + 1 + word.length > maxWidth) {
                lines.push(line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        if (line) lines.push(line);
    }
    return lines.join("\n");
}

const SUPPORTED_GOAL_EXTENSIONS = [".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".rst", ".adoc"];

export function resolveGoalFromFile(
    input: string,
    workspaceDir?: string,
    logFn?: (level: "info" | "warn" | "error", msg: string) => void,
): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const hasValidExtension = SUPPORTED_GOAL_EXTENSIONS.some(ext => trimmed.endsWith(ext));
    if (!hasValidExtension) return null;

    const searchPaths: string[] = [];

    if (path.isAbsolute(trimmed)) {
        searchPaths.push(trimmed);
    } else {
        if (workspaceDir) {
            searchPaths.push(path.resolve(workspaceDir, trimmed));
        }
        searchPaths.push(path.resolve(process.cwd(), trimmed));
    }

    for (const absolutePath of searchPaths) {
        if (!existsSync(absolutePath)) continue;

        try {
            const content = readFileSync(absolutePath, "utf-8");
            const filename = path.basename(absolutePath);
            logFn?.("info", `📖 Goal loaded from file: ${filename}`);
            return content;
        } catch {
            continue;
        }
    }

    return null;
}

export async function suggestGoalFromWorkspace(
    workspacePath: string,
    currentGoal: string,
): Promise<string | null> {
    const s = spinner();
    try {
        s.start(randomPhrase("file"));
        const entryNames = await readdir(workspacePath);

        const keyFiles = ["docs/ARCHITECTURE.md", "DOCS/PLANNING.md", "README.md", "package.json"];
        let context = "";
        const maxPerFile = 2000;
        const maxTotal = 8000;

        for (const kf of keyFiles) {
            if (context.length >= maxTotal) break;
            try {
                const content = await readFile(path.join(workspacePath, kf), "utf-8");
                const truncated = content.slice(0, maxPerFile);
                context += `\n--- ${kf} ---\n${truncated}\n`;
            } catch {
                // file doesn't exist, skip
            }
        }

        const dirListing = entryNames.join(", ");
        const prompt = [
            "Given a workspace with these files:",
            dirListing,
            context ? "\nKey file contents:" + context : "",
            `\nThe previous goal was: "${currentGoal}"`,
            "\nSuggest an updated goal that accounts for the existing work. Respond with ONLY the goal text, no explanation.",
        ].join("\n");

        const pm = getGlobalProviderManager();
        if (pm.getProviders().length === 0) {
            s.stop("No LLM providers configured.");
            return null;
        }

        s.message(randomPhrase("ai"));
        const { text: resultText } = await pm.generate(prompt, {
            systemPrompt: [
                "You are a project planning assistant that writes clear, actionable goals for AI agent teams.",
                "Given workspace context, suggest an updated goal that:",
                "- Uses specific action verbs (build, implement, add, create) instead of vague ones (improve, fix, update)",
                "- References concrete components from the workspace",
                "- Includes measurable success criteria when possible",
                "Respond with ONLY the goal text (2-4 sentences). No explanation or markdown.",
            ].join(" "),
            temperature: 0.7,
            signal: AbortSignal.timeout(30_000),
        });

        const suggestion = resultText.trim();
        if (!suggestion) {
            s.stop("AI returned an empty suggestion.");
            return null;
        }

        s.stop("Got a suggestion!");
        return suggestion;
    } catch {
        s.stop("Could not get AI suggestion.");
        return null;
    }
}

export async function refineGoalWithAI(
    currentGoal: string,
    issues: Array<{ type: string; question: string; severity: string }>,
    suggestions: string[],
): Promise<string | null> {
    const s = spinner();
    try {
        const pm = getGlobalProviderManager();
        if (pm.getProviders().length === 0) {
            return null;
        }

        s.start(randomPhrase("ai"));

        const issueList = issues.map((i) => `- [${i.severity}] ${i.question}`).join("\n");
        const suggestionList = suggestions.length > 0
            ? "\n\nExisting suggestions:\n" + suggestions.map((s) => `- ${s}`).join("\n")
            : "";

        const prompt = [
            `Original goal: "${currentGoal}"`,
            `\nClarity issues found:\n${issueList}`,
            suggestionList,
            "\nRewrite this goal to address ALL the issues above. Respond with ONLY the refined goal text (2-4 sentences). No explanation or markdown.",
        ].join("\n");

        const { text: resultText } = await pm.generate(prompt, {
            systemPrompt: [
                "You are a project planning assistant that rewrites unclear goals into clear, actionable ones.",
                "Rules: use specific action verbs (build, implement, add, create) instead of vague ones (improve, fix, update).",
                "Replace ambiguous references (it, that, the thing) with concrete nouns.",
                "Include measurable success criteria.",
                "Keep the original intent — only clarify, don't change the scope.",
            ].join(" "),
            temperature: 0.7,
            signal: AbortSignal.timeout(30_000),
        });

        const refined = resultText.trim();
        if (!refined) {
            s.stop("AI returned an empty result.");
            return null;
        }

        s.stop("Done!");
        return refined;
    } catch {
        s.stop("Could not reach AI — try rephrasing manually.");
        return null;
    }
}

export async function checkWorkspaceContent(
    workspacePath: string,
    currentGoal: string,
    canRenderSpinner: boolean,
): Promise<{ goal: string; cleared: boolean }> {
    if (!canRenderSpinner) return { goal: currentGoal, cleared: false };

    let entryNames: { name: string; isFile: boolean; isDir: boolean }[];
    try {
        const raw = await readdir(workspacePath, { withFileTypes: true });
        entryNames = raw.map((e) => ({ name: String(e.name), isFile: e.isFile(), isDir: e.isDirectory() }));
    } catch {
        return { goal: currentGoal, cleared: false };
    }

    const userEntries = entryNames.filter((e) => !WORKSPACE_PROTECTED.has(e.name));
    if (userEntries.length === 0) return { goal: currentGoal, cleared: false };

    // Build summary
    const fileCount = userEntries.filter((e) => e.isFile).length;
    const dirCount = userEntries.filter((e) => e.isDir).length;
    const listed = userEntries.slice(0, 10).map((e) => e.name);
    const extra = userEntries.length - listed.length;
    let summary = `${fileCount} file(s), ${dirCount} dir(s)\n`;
    summary += listed.join(", ");
    if (extra > 0) summary += `, +${extra} more`;

    note(summary, "Existing workspace content");

    const action = await select({
        message: "Workspace already has content. What would you like to do?",
        options: [
            { value: "fresh", label: "Start fresh (remove existing files)" },
            { value: "keep", label: "Keep existing files" },
        ],
    });

    if (isCancel(action)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (action === "fresh") {
        for (const entry of userEntries) {
            try {
                await rm(path.join(workspacePath, entry.name), { recursive: true, force: true });
            } catch (err) {
                clackLog.warn(`Could not remove ${entry.name}: ${err}`);
            }
        }
        clackLog.info("Workspace cleared.");
        return { goal: currentGoal, cleared: true };
    }

    // Keep files — offer goal adjustment
    const goalAction = await select({
        message: "Adjust your goal for the existing workspace?",
        options: [
            { value: "keep_goal", label: "Keep current goal" },
            { value: "edit", label: "Edit goal manually" },
            { value: "ai", label: "AI-suggested goal" },
        ],
    });

    if (isCancel(goalAction)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (goalAction === "keep_goal") {
        return { goal: currentGoal, cleared: false };
    }

    if (goalAction === "edit") {
        const newGoal = await text({
            message: "Enter updated goal:",
            initialValue: currentGoal,
        });
        if (isCancel(newGoal) || !String(newGoal).trim()) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        return { goal: String(newGoal).trim(), cleared: false };
    }

    // AI suggestion
    const suggestion = await suggestGoalFromWorkspace(workspacePath, currentGoal);
    if (!suggestion) {
        clackLog.warn("AI suggestion failed. You can edit the goal manually.");
        const fallback = await text({
            message: "Enter updated goal:",
            initialValue: currentGoal,
        });
        if (isCancel(fallback) || !String(fallback).trim()) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        return { goal: String(fallback).trim(), cleared: false };
    }

    note(suggestion, "AI-suggested goal");

    const acceptAction = await select({
        message: "Use this suggestion?",
        options: [
            { value: "accept", label: "Accept" },
            { value: "edit", label: "Edit suggestion" },
            { value: "discard", label: "Discard (keep original)" },
        ],
    });

    if (isCancel(acceptAction)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (acceptAction === "accept") {
        return { goal: suggestion, cleared: false };
    }
    if (acceptAction === "edit") {
        const edited = await text({
            message: "Edit the suggested goal:",
            initialValue: suggestion,
        });
        if (isCancel(edited) || !String(edited).trim()) {
            cancel("Work session cancelled.");
            process.exit(0);
        }
        return { goal: String(edited).trim(), cleared: false };
    }

    return { goal: currentGoal, cleared: false };
}

export async function promptGoalChoice(): Promise<{ mode: "file" | "manual"; value: string }> {
    const choice = await select({
        message: "How would you like to input your goal?",
        options: [
            { label: "Type goal manually", value: "manual" },
            { label: "Load from file path", value: "file" },
        ],
    });

    if (isCancel(choice)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (choice === "file") {
        const filePath = await text({
            message: "Enter file path:",
            placeholder: "goal.md, requirements.txt, etc.",
        });

        if (isCancel(filePath) || !String(filePath).trim()) {
            cancel("Work session cancelled: no file path provided.");
            process.exit(0);
        }

        return { mode: "file", value: String(filePath).trim() };
    }

    logger.plain([
        "",
        "  Examples:",
        '  · "Add rate limiting to the auth API"',
        '  · "Build a caching layer for user profiles"',
        '  · "Write tests for the payment module"',
        '  · "Refactor the database queries in orders.ts"',
        "",
        "  Tip: Be specific. The more detail you give, the better",
        "  the team can plan.",
        "",
    ].join("\n"));

    const goalInput = await text({
        message: "What's your goal for this session?",
        placeholder: "Describe what you want to build or fix...",
    });

    if (isCancel(goalInput) || !String(goalInput).trim()) {
        cancel("Work session cancelled: no goal provided.");
        process.exit(0);
    }

    return { mode: "manual", value: String(goalInput).trim() };
}

/**
 * Run pre-flight drift + clarity checks on the goal.
 * Returns the (possibly refined) goal, or throws UserCancelError on abort.
 */
export async function runPreFlightChecks(goal: string): Promise<string> {
    let effectiveGoal = goal;

    // Run both checks concurrently
    const runDriftCheck = async (): Promise<import("../drift/types.js").DriftResult | null> => {
        try {
            const { detectDrift } = await import("../drift/detector.js");
            const { DecisionStore } = await import("../journal/store.js");
            const { GlobalMemoryManager } = await import("../memory/global/store.js");

            const vmForDrift = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
            await vmForDrift.init();
            const embedderForDrift = vmForDrift.getEmbedder();

            let decisions: import("../journal/types.js").Decision[] = [];
            if (embedderForDrift) {
                const gmDrift = new GlobalMemoryManager();
                await gmDrift.init(embedderForDrift);
                const dbDrift = gmDrift.getDb();
                if (dbDrift) {
                    const dStore = new DecisionStore();
                    await dStore.init(dbDrift);
                    decisions = await dStore.getAll();
                }
            }

            return detectDrift(goal, decisions);
        } catch {
            return null;
        }
    };

    const runClarityCheck = async (): Promise<import("../clarity/types.js").ClarityResult | null> => {
        try {
            const { analyzeClarity } = await import("../clarity/analyzer.js");
            return analyzeClarity(goal);
        } catch {
            return null;
        }
    };

    const [driftResult, clarityResult] = await Promise.all([
        runDriftCheck(),
        runClarityCheck(),
    ]);

    const hasDriftIssues = driftResult?.hasDrift === true;
    const hasClarityIssues = clarityResult && !clarityResult.isClear;

    if (hasDriftIssues && hasClarityIssues) {
        effectiveGoal = await handleCombinedIssues(effectiveGoal, driftResult, clarityResult);
    } else {
        if (hasDriftIssues && driftResult) {
            effectiveGoal = await handleDriftOnly(effectiveGoal, driftResult);
        }
        if (hasClarityIssues && clarityResult) {
            effectiveGoal = await handleClarityOnly(effectiveGoal, clarityResult);
        }
        if (!hasDriftIssues && !hasClarityIssues) {
            if (clarityResult?.isClear) {
                logger.plain(pc.green("✓ Goal is clear."));
            }
        }
    }

    return effectiveGoal;
}

/** Handle case where both drift AND clarity issues are present. */
async function handleCombinedIssues(
    effectiveGoal: string,
    driftResult: import("../drift/types.js").DriftResult,
    clarityResult: import("../clarity/types.js").ClarityResult,
): Promise<string> {
    const { select: clackSelect, isCancel: clackIsCancel } = await import("@clack/prompts");

    logger.plain(`\n⚠️  ${pc.yellow("Goal clarity issues:")}`);
    for (const issue of clarityResult.issues) {
        const badge = issue.severity === "blocking" ? pc.red("[blocking]") : pc.yellow("[advisory]");
        logger.plain(`  - ${badge} ${issue.question}`);
    }

    const icon = driftResult.severity === "hard" ? "🚨" : "⚠️";
    logger.plain(`\n${icon} ${pc.yellow("Drift conflicts:")}`);
    for (const conflict of driftResult.conflicts) {
        logger.plain(`  - ${conflict.explanation}`);
    }

    const hasBlocking = clarityResult.issues.some((i) => i.severity === "blocking") || driftResult.severity === "hard";
    if (hasBlocking) {
        logger.plain(pc.red("\nBlocking issues detected — must be resolved before proceeding."));
    }

    const choice = await clackSelect({
        message: "Both clarity and drift issues found. How would you like to proceed?",
        options: [
            { label: "Refine with AI", value: "ai_refine" },
            { label: "Rephrase my goal", value: "rephrase" },
            { label: "Proceed anyway", value: "proceed" },
            { label: "Abort", value: "abort" },
        ],
    });

    if (clackIsCancel(choice) || choice === "abort") {
        throw new UserCancelError("Work session cancelled.");
    }

    if (choice === "ai_refine") {
        return await applyAIRefinement(effectiveGoal, clarityResult);
    }
    if (choice === "rephrase") {
        return await promptRephrase(effectiveGoal);
    }
    return effectiveGoal; // "proceed"
}

/** Handle drift-only issues. */
async function handleDriftOnly(
    effectiveGoal: string,
    driftResult: import("../drift/types.js").DriftResult,
): Promise<string> {
    let driftRetries = 0;
    const MAX_DRIFT_RETRIES = 3;
    let goalToCheck = effectiveGoal;
    let currentDriftResult: import("../drift/types.js").DriftResult | null = driftResult;

    while (currentDriftResult?.hasDrift) {
        const { select: clackSelect, text: clackText, isCancel: clackIsCancel } = await import("@clack/prompts");

        const dIcon = currentDriftResult.severity === "hard" ? "🚨" : "⚠";
        const dLabel = currentDriftResult.severity === "hard" ? "Strong drift detected" : "Drift detected";
        logger.plain(`\n${dIcon} ${pc.yellow(`${dLabel} — ${currentDriftResult.conflicts.length} conflict(s) with past decisions`)}`);

        const hasPermanent = currentDriftResult.conflicts.some((c) => c.decision.permanent);

        for (const conflict of currentDriftResult.conflicts) {
            const d = conflict.decision;
            const date = new Date(d.capturedAt).toISOString().slice(0, 10);
            const lockIcon = d.permanent ? " 🔒" : "";
            logger.plain(pc.dim("─".repeat(50)));
            logger.plain(`${conflict.explanation}${lockIcon}`);
            logger.plain(pc.dim(`Past decision (${date}, ${d.recommendedBy}, confidence ${d.confidence.toFixed(2)}):`));
            logger.plain(pc.dim(`"${d.decision}"`));
            logger.plain(pc.dim(`Reasoning: "${d.reasoning.slice(0, 100)}${d.reasoning.length > 100 ? "..." : ""}"`));
        }
        logger.plain(pc.dim("─".repeat(50)));

        const options: Array<{ label: string; value: string }> = [];
        if (!hasPermanent) {
            options.push({ label: "Proceed anyway — I know what I'm doing", value: "proceed" });
        }
        options.push(
            { label: "Reconsider the past decision(s) — they no longer apply", value: "reconsider" },
            { label: "Adjust my goal — let me rephrase it", value: "adjust_goal" },
            { label: "Abort — I need to think about this", value: "abort" },
        );

        const choice = await clackSelect({ message: "How would you like to proceed?", options });

        if (clackIsCancel(choice) || choice === "abort") {
            throw new UserCancelError("Work session cancelled due to drift conflict.");
        }

        if (choice === "reconsider") {
            try {
                const { DecisionStore } = await import("../journal/store.js");
                const { GlobalMemoryManager } = await import("../memory/global/store.js");
                const vmRecon = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
                await vmRecon.init();
                const embedderRecon = vmRecon.getEmbedder();
                if (embedderRecon) {
                    const gmRecon = new GlobalMemoryManager();
                    await gmRecon.init(embedderRecon);
                    const dbRecon = gmRecon.getDb();
                    if (dbRecon) {
                        const reconStore = new DecisionStore();
                        await reconStore.init(dbRecon);
                        for (const c of currentDriftResult.conflicts) {
                            await reconStore.markReconsidered(c.decision.id);
                        }
                        logger.success(`Reconsidered ${currentDriftResult.conflicts.length} past decision(s).`);
                    }
                }
            } catch { /* Non-critical */ }
            break;
        }

        if (choice === "adjust_goal") {
            driftRetries++;
            if (driftRetries >= MAX_DRIFT_RETRIES) {
                logger.warn("Max goal adjustment retries reached. Proceeding with current goal.");
                break;
            }
            const newGoalInput = await clackText({ message: "Enter adjusted goal:", placeholder: goalToCheck });
            if (clackIsCancel(newGoalInput) || !newGoalInput) {
                throw new UserCancelError("Work session cancelled.");
            }
            goalToCheck = String(newGoalInput).trim();
            effectiveGoal = goalToCheck;

            try {
                const { detectDrift } = await import("../drift/detector.js");
                const { DecisionStore } = await import("../journal/store.js");
                const { GlobalMemoryManager } = await import("../memory/global/store.js");
                const vmRe = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
                await vmRe.init();
                const embedderRe = vmRe.getEmbedder();
                let reDecisions: import("../journal/types.js").Decision[] = [];
                if (embedderRe) {
                    const gmRe = new GlobalMemoryManager();
                    await gmRe.init(embedderRe);
                    const dbRe = gmRe.getDb();
                    if (dbRe) {
                        const dStoreRe = new DecisionStore();
                        await dStoreRe.init(dbRe);
                        reDecisions = await dStoreRe.getAll();
                    }
                }
                currentDriftResult = detectDrift(goalToCheck, reDecisions);
            } catch { break; }
            continue;
        }

        // choice === "proceed"
        break;
    }
    return effectiveGoal;
}

/** Handle clarity-only issues. */
async function handleClarityOnly(
    effectiveGoal: string,
    clarityResult: import("../clarity/types.js").ClarityResult,
): Promise<string> {
    try {
        const { generateQuestions } = await import("../clarity/questioner.js");
        const { rewriteGoal: rewriteGoalClar } = await import("../clarity/rewriter.js");
        const { suggestSplits } = await import("../clarity/breadth-analyzer.js");
        const { select: clackSelect, text: clackText, isCancel: clackIsCancel } = await import("@clack/prompts");

        const cIcon = clarityResult.score < 0.5 ? "🚨" : "🔍";
        const cLabel = clarityResult.score < 0.5
            ? "This goal needs clarification before the team can plan"
            : "This goal could be clearer";

        logger.plain(`\n${cIcon} ${pc.yellow("Goal clarity check...")}`);
        logger.plain(pc.dim("┌─────────────────────────────────────────────────────────────┐"));
        logger.plain(`│ ${cLabel}`);
        logger.plain(pc.dim("├─────────────────────────────────────────────────────────────┤"));
        for (const issue of clarityResult.issues) {
            const badge = issue.severity === "blocking" ? pc.red("[blocking]") : pc.yellow("[advisory]");
            logger.plain(`│ ${badge} ${issue.question}`);
        }
        logger.plain(pc.dim("└─────────────────────────────────────────────────────────────┘"));

        if (clarityResult.suggestions.length > 0) {
            logger.plain(pc.dim("Suggestions:"));
            for (const s of clarityResult.suggestions) { logger.plain(pc.dim(`  → ${s}`)); }
        }

        const hasTooWide = clarityResult.issues.some((i) => i.type === "too_broad");
        const options: Array<{ label: string; value: string }> = [
            { label: "Answer the questions — I'll clarify the goal", value: "clarify" },
            { label: "Refine with AI", value: "ai_refine" },
            { label: "Proceed anyway — I want the team to interpret it", value: "proceed" },
            { label: "Rephrase my goal", value: "rephrase" },
        ];
        if (hasTooWide) {
            options.push({ label: "Split into focused goals", value: "split" });
        }

        const choice = await clackSelect({ message: "How would you like to proceed?", options });
        if (clackIsCancel(choice)) { throw new UserCancelError("Work session cancelled."); }

        if (choice === "clarify") {
            const questions = generateQuestions(clarityResult.issues);
            const answers: Array<{ issue: (typeof questions)[0]["issue"]; answer: string }> = [];
            for (const q of questions) {
                const answer = await clackText({ message: q.question, placeholder: q.placeholder });
                if (clackIsCancel(answer)) { throw new UserCancelError("Work session cancelled."); }
                answers.push({ issue: q.issue, answer: String(answer).trim() });
            }
            const clarified = rewriteGoalClar(effectiveGoal, answers);
            logger.plain(pc.bold("Clarified goal:"));
            logger.plain(pc.green(`"${clarified}"`));
            logger.plain(pc.green("✓ Goal is clear. Proceeding to decomposition."));
            return clarified;
        }
        if (choice === "ai_refine") {
            return await applyAIRefinement(effectiveGoal, clarityResult);
        }
        if (choice === "rephrase") {
            return await promptRephrase(effectiveGoal);
        }
        if (choice === "split") {
            const breadthIssue = clarityResult.issues.find((i) => i.type === "too_broad");
            const domains = breadthIssue
                ? breadthIssue.question.match(/domains?:\s*(.+?)\./)?.[1]?.split(", ") ?? []
                : [];
            const splits = suggestSplits(effectiveGoal, domains);
            if (splits.length > 0) {
                logger.plain(pc.bold("Suggested sub-goals:"));
                const splitOptions = splits.map((s, i) => ({ label: s, value: String(i) }));
                const picked = await clackSelect({ message: "Pick one to run now (others saved to backlog):", options: splitOptions });
                if (!clackIsCancel(picked)) {
                    const idx = Number(picked);
                    const pickedGoal = splits[idx] ?? effectiveGoal;
                    logger.plain(pc.green(`✓ Running: "${pickedGoal}"`));
                    return pickedGoal;
                }
            }
        }
        // "proceed" or split with no pick
        return effectiveGoal;
    } catch (err) {
        if (err instanceof UserCancelError) throw err;
        logger.warn("Clarity check interaction failed — proceeding without it.");
        return effectiveGoal;
    }
}

/** Shared: apply AI refinement to a goal. */
async function applyAIRefinement(
    effectiveGoal: string,
    clarityResult: import("../clarity/types.js").ClarityResult,
): Promise<string> {
    const { select: clackSelect, text: clackText, isCancel: clackIsCancel, note: clackNote } = await import("@clack/prompts");
    const refined = await refineGoalWithAI(
        effectiveGoal,
        clarityResult.issues.map((i) => ({ type: i.type, question: i.question, severity: i.severity })),
        clarityResult.suggestions,
    );
    if (refined) {
        clackNote(
            wrapText([`${pc.dim("Original:")} ${effectiveGoal}`, "", `${pc.green("Refined:")} ${refined}`].join("\n")),
            "AI-refined goal",
        );
        const acceptChoice = await clackSelect({
            message: "Use this refined goal?",
            options: [
                { label: "Accept", value: "accept" },
                { label: "Edit the refined version", value: "edit" },
                { label: "Discard (keep original)", value: "discard" },
            ],
        });
        if (clackIsCancel(acceptChoice)) { throw new UserCancelError("Work session cancelled."); }
        if (acceptChoice === "accept") {
            logger.plain(pc.green("✓ Goal refined. Proceeding to decomposition."));
            return refined;
        }
        if (acceptChoice === "edit") {
            const edited = await clackText({ message: "Edit the refined goal:", initialValue: refined });
            if (clackIsCancel(edited) || !edited) { throw new UserCancelError("Work session cancelled."); }
            logger.plain(pc.green("✓ Goal updated. Proceeding to decomposition."));
            return String(edited).trim();
        }
        // "discard"
        return effectiveGoal;
    }
    logger.warn("AI refinement unavailable. You can rephrase manually.");
    return await promptRephrase(effectiveGoal);
}

/** Shared: prompt user to rephrase goal. */
async function promptRephrase(effectiveGoal: string): Promise<string> {
    const { text: clackText, isCancel: clackIsCancel } = await import("@clack/prompts");
    const newGoal = await clackText({ message: "Enter your revised goal:", placeholder: effectiveGoal });
    if (clackIsCancel(newGoal) || !newGoal) { throw new UserCancelError("Work session cancelled."); }
    logger.plain(pc.green("✓ Goal updated. Proceeding to decomposition."));
    return String(newGoal).trim();
}
