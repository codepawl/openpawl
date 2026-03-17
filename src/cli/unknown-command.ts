/**
 * Error message formatting for unknown commands/subcommands.
 */

import pc from "picocolors";
import type { MatchResult } from "./fuzzy-matcher.js";

type UnknownCommandOptions = {
    command: string;
    subcommand?: string;
    suggestion: MatchResult;
};

function useColor(): boolean {
    return !process.env["NO_COLOR"];
}

function yellow(text: string): string {
    return useColor() ? pc.yellow(text) : text;
}

function white(text: string): string {
    return useColor() ? pc.white(text) : text;
}

export function formatUnknownCommand(opts: UnknownCommandOptions): string {
    const { command, subcommand, suggestion } = opts;

    if (!subcommand) {
        if (suggestion.suggestion) {
            const hint = suggestion.confidence === "low" ? " (not sure?)" : "";
            return [
                white(`Unknown command "${command}".`),
                yellow(`Did you mean \`teamclaw ${suggestion.suggestion}\`?${hint}`),
                "",
                `Run \`teamclaw --help\` to see all commands.`,
            ].join("\n");
        }
        return [
            white(`Unknown command "${command}".`),
            `Run \`teamclaw --help\` to see all commands.`,
        ].join("\n");
    }

    if (suggestion.suggestion) {
        return [
            white(`Unknown subcommand "${subcommand}" for \`teamclaw ${command}\`.`),
            yellow(`Did you mean \`teamclaw ${command} ${suggestion.suggestion}\`?`),
            "",
            `Run \`teamclaw ${command} --help\` to see available subcommands.`,
        ].join("\n");
    }

    return [
        white(`Unknown subcommand "${subcommand}" for \`teamclaw ${command}\`.`),
        `Run \`teamclaw ${command} --help\` to see available subcommands.`,
    ].join("\n");
}

/**
 * Print unknown command/subcommand message to stderr and exit.
 */
export function handleUnknownCommand(
    command: string,
    suggestion: MatchResult,
): never {
    process.stderr.write(formatUnknownCommand({ command, suggestion }) + "\n");
    process.exit(1);
}

/**
 * Print unknown subcommand message to stderr and exit.
 */
export function handleUnknownSubcommand(
    command: string,
    subcommand: string,
    suggestion: MatchResult,
): never {
    process.stderr.write(
        formatUnknownCommand({ command, subcommand, suggestion }) + "\n",
    );
    process.exit(1);
}
