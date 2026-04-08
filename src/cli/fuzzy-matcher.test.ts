import { describe, it, expect } from "bun:test";
import {
    findClosestCommand,
    findClosestSubcommand,
    scoreMatch,
} from "./fuzzy-matcher.js";

describe("scoreMatch", () => {
    it("applies prefix bonus for shared first 2 chars", () => {
        // "work" vs "wrk" — "wo" prefix not shared, vs "work" vs "worm" — "wo" shared
        const scoreNoPrefix = scoreMatch("xyz", "work");
        const scoreWithPrefix = scoreMatch("worl", "work");
        // With prefix bonus, the score should be lower
        expect(scoreWithPrefix).toBeLessThan(scoreNoPrefix);
    });

    it("applies length penalty for different lengths", () => {
        // Same distance but different length gaps should yield different scores
        const scoreSameLen = scoreMatch("wrk", "work"); // length diff = 1
        const scoreDiffLen = scoreMatch("wk", "work"); // length diff = 2
        expect(scoreDiffLen).toBeGreaterThan(scoreSameLen);
    });
});

describe("findClosestCommand", () => {
    it('suggests "models" for "modals" (distance 1)', () => {
        const result = findClosestCommand("modals");
        expect(result.suggestion).toBe("models");
        expect(result.confidence).not.toBe("none");
    });

    it('suggests "config" for "conifg" (transposition)', () => {
        const result = findClosestCommand("conifg");
        expect(result.suggestion).toBe("config");
        expect(result.confidence).not.toBe("none");
    });

    it('suggests "work" for "wrk" (distance 1)', () => {
        const result = findClosestCommand("wrk");
        expect(result.suggestion).toBe("work");
        expect(result.confidence).toBe("high");
    });

    it('returns no suggestion for "xyz" (distance too high)', () => {
        const result = findClosestCommand("xyz");
        expect(result.suggestion).toBeNull();
        expect(result.confidence).toBe("none");
    });

    it("handles case-insensitive exact match", () => {
        const result = findClosestCommand("SETUP");
        expect(result.suggestion).toBe("setup");
        expect(result.distance).toBe(0);
        expect(result.confidence).toBe("high");
    });

    it("skips fuzzy match for input > 20 chars", () => {
        const result = findClosestCommand("abcdefghijklmnopqrstuv");
        expect(result.suggestion).toBeNull();
        expect(result.confidence).toBe("none");
    });

    it("works with custom candidates list", () => {
        const result = findClosestCommand("gett", ["get", "set", "unset"]);
        expect(result.suggestion).toBe("get");
    });

    it("returns none when candidates list is empty", () => {
        const result = findClosestCommand("anything", []);
        expect(result.suggestion).toBeNull();
        expect(result.confidence).toBe("none");
    });
});

describe("findClosestSubcommand", () => {
    it('suggests "get" for config subcommand "gett"', () => {
        const result = findClosestSubcommand("config", "gett");
        expect(result.suggestion).toBe("get");
    });

    it('suggests "set" for model subcommand "ste"', () => {
        const result = findClosestSubcommand("model", "ste");
        expect(result.suggestion).toBe("set");
    });

    it('suggests "list" for replay subcommand "lits"', () => {
        const result = findClosestSubcommand("replay", "lits");
        expect(result.suggestion).toBe("list");
    });

    it("returns none for parent with no subcommands", () => {
        const result = findClosestSubcommand("heatmap", "foo");
        expect(result.suggestion).toBeNull();
        expect(result.confidence).toBe("none");
    });

    it("returns none for unknown parent command", () => {
        const result = findClosestSubcommand("nonexistent", "foo");
        expect(result.suggestion).toBeNull();
        expect(result.confidence).toBe("none");
    });
});
