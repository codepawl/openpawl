/**
 * Fuzzy command matching using Damerau-Levenshtein distance.
 */

import levenshtein from "damerau-levenshtein";
import { getAllCommandNames } from "./command-registry.js";

/** All valid top-level openpawl commands (derived from registry + hidden commands). */
export const COMMANDS: readonly string[] = [
    ...getAllCommandNames(),
    "onboard",       // hidden: internal daemon setup
    "think-worker",  // hidden: internal async worker
];

/** Known subcommands keyed by parent command. */
export const SUBCOMMANDS: Record<string, string[]> = {
    config: ["get", "set", "unset"],
    model: ["list", "get", "set", "reset"],
    logs: ["gateway"],
    lessons: ["promote", "demote"],
    memory: ["health", "rebuild", "prune", "export", "import"],
    profile: ["list", "show", "reset"],
    replay: ["list", "tag", "untag", "prune", "clean", "export", "diff"],
    audit: ["list", "open"],
    agent: ["add", "list", "show", "remove", "validate", "test"],
    forecast: ["accuracy"],
    heatmap: [],
    diff: [],
    think: ["history"],
    handoff: ["import"],
    score: ["history"],
    journal: ["list", "search", "show", "export"],
    clarity: [],
    drift: [],
    templates: ["browse", "search", "install", "remove", "list", "show", "validate", "publish", "init", "update"],
    cache: ["stats", "clear", "prune", "disable", "enable"],
    providers: ["list", "test"],
};

export type MatchResult = {
    input: string;
    suggestion: string | null;
    distance: number;
    confidence: "high" | "low" | "none";
};

export function scoreMatch(input: string, command: string): number {
    const dist = levenshtein(input, command).steps;

    // Prefix bonus — shared first 2 chars reduces score by 1
    const prefixBonus = command.startsWith(input.slice(0, 2)) ? 1 : 0;

    // Length penalty — prefer shorter commands at same distance
    const lengthPenalty = Math.abs(input.length - command.length) * 0.1;

    return dist - prefixBonus + lengthPenalty;
}

/**
 * Find the closest command from a list of candidates.
 * If no candidates provided, uses top-level COMMANDS.
 */
export function findClosestCommand(
    input: string,
    candidates?: readonly string[],
): MatchResult {
    const list = candidates ?? COMMANDS;

    // Skip fuzzy matching for very long input
    if (input.length > 20) {
        return { input, suggestion: null, distance: Infinity, confidence: "none" };
    }

    const lower = input.toLowerCase();

    // Case-insensitive exact match
    const exact = list.find((c) => c.toLowerCase() === lower);
    if (exact) {
        return { input, suggestion: exact, distance: 0, confidence: "high" };
    }

    const scores = list
        .map((cmd) => ({ cmd, score: scoreMatch(lower, cmd) }))
        .sort((a, b) => a.score - b.score);

    const best = scores[0];
    if (!best) {
        return { input, suggestion: null, distance: Infinity, confidence: "none" };
    }

    if (best.score <= 1.5) {
        return { input, suggestion: best.cmd, distance: best.score, confidence: "high" };
    }
    if (best.score < 3) {
        return { input, suggestion: best.cmd, distance: best.score, confidence: "low" };
    }
    return { input, suggestion: null, distance: best.score, confidence: "none" };
}

/**
 * Find closest subcommand for a given parent command.
 */
export function findClosestSubcommand(
    parentCommand: string,
    subcommand: string,
): MatchResult {
    const subs = SUBCOMMANDS[parentCommand];
    if (!subs || subs.length === 0) {
        return { input: subcommand, suggestion: null, distance: Infinity, confidence: "none" };
    }
    return findClosestCommand(subcommand, subs);
}
