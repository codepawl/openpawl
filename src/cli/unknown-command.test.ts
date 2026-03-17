import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatUnknownCommand } from "./unknown-command.js";
import type { MatchResult } from "./fuzzy-matcher.js";

describe("formatUnknownCommand", () => {
    describe("top-level commands", () => {
        it("renders message with suggestion", () => {
            const suggestion: MatchResult = {
                input: "modals",
                suggestion: "model",
                distance: 1,
                confidence: "high",
            };
            const msg = formatUnknownCommand({ command: "modals", suggestion });
            expect(msg).toContain('Unknown command "modals"');
            expect(msg).toContain("Did you mean `teamclaw model`?");
            expect(msg).toContain("teamclaw --help");
            expect(msg).not.toContain("(not sure?)");
        });

        it("renders message without suggestion", () => {
            const suggestion: MatchResult = {
                input: "xyz",
                suggestion: null,
                distance: 10,
                confidence: "none",
            };
            const msg = formatUnknownCommand({ command: "xyz", suggestion });
            expect(msg).toContain('Unknown command "xyz"');
            expect(msg).toContain("teamclaw --help");
            expect(msg).not.toContain("Did you mean");
        });

        it('shows "(not sure?)" for low confidence', () => {
            const suggestion: MatchResult = {
                input: "chk",
                suggestion: "check",
                distance: 2.5,
                confidence: "low",
            };
            const msg = formatUnknownCommand({ command: "chk", suggestion });
            expect(msg).toContain("(not sure?)");
            expect(msg).toContain("Did you mean `teamclaw check`?");
        });
    });

    describe("subcommands", () => {
        it("renders subcommand suggestion", () => {
            const suggestion: MatchResult = {
                input: "gett",
                suggestion: "get",
                distance: 1,
                confidence: "high",
            };
            const msg = formatUnknownCommand({
                command: "config",
                subcommand: "gett",
                suggestion,
            });
            expect(msg).toContain('Unknown subcommand "gett" for `teamclaw config`');
            expect(msg).toContain("Did you mean `teamclaw config get`?");
            expect(msg).toContain("teamclaw config --help");
        });

        it("renders subcommand without suggestion", () => {
            const suggestion: MatchResult = {
                input: "zzz",
                suggestion: null,
                distance: 10,
                confidence: "none",
            };
            const msg = formatUnknownCommand({
                command: "config",
                subcommand: "zzz",
                suggestion,
            });
            expect(msg).toContain('Unknown subcommand "zzz" for `teamclaw config`');
            expect(msg).not.toContain("Did you mean");
            expect(msg).toContain("teamclaw config --help");
        });
    });

    describe("NO_COLOR", () => {
        const origNoColor = process.env["NO_COLOR"];

        beforeEach(() => {
            process.env["NO_COLOR"] = "1";
        });

        afterEach(() => {
            if (origNoColor === undefined) {
                delete process.env["NO_COLOR"];
            } else {
                process.env["NO_COLOR"] = origNoColor;
            }
        });

        it("strips color codes from output", () => {
            const suggestion: MatchResult = {
                input: "modals",
                suggestion: "model",
                distance: 1,
                confidence: "high",
            };
            const msg = formatUnknownCommand({ command: "modals", suggestion });
            const hasAnsi = /\x1b\[/.test(msg);
            expect(hasAnsi).toBe(false);
            expect(msg).toContain('Unknown command "modals"');
            expect(msg).toContain("Did you mean `teamclaw model`?");
        });
    });
});
