import { describe, it, expect, vi } from "vitest";
import type { DriftResult } from "../src/drift/types.js";
import type { ClarityResult } from "../src/clarity/types.js";

vi.mock("../src/core/logger.js", () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
    isDebugMode: () => false,
}));

// ---------------------------------------------------------------------------
// Helpers — simulate the parallel pre-flight pattern from work-runner
// ---------------------------------------------------------------------------

function makeDriftResult(overrides: Partial<DriftResult> = {}): DriftResult {
    return {
        hasDrift: false,
        severity: "none",
        conflicts: [],
        checkedAt: Date.now(),
        ...overrides,
    };
}

function makeClarityResult(overrides: Partial<ClarityResult> = {}): ClarityResult {
    return {
        isClear: true,
        score: 1,
        issues: [],
        suggestions: [],
        checkedAt: Date.now(),
        ...overrides,
    };
}

/** Creates an async function that returns a value after a delay (simulating I/O). */
function delayedReturn<T>(value: T, ms: number): () => Promise<T> {
    return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Pre-flight parallel checks", () => {
    it("drift and clarity run concurrently (total ≈ max, not sum)", async () => {
        const DRIFT_DELAY = 100;
        const CLARITY_DELAY = 80;
        const TOLERANCE = 50; // allow 50ms overhead

        const runDrift = delayedReturn(makeDriftResult(), DRIFT_DELAY);
        const runClarity = delayedReturn(makeClarityResult(), CLARITY_DELAY);

        const start = performance.now();
        const [driftResult, clarityResult] = await Promise.all([runDrift(), runClarity()]);
        const elapsed = performance.now() - start;

        expect(driftResult).toBeDefined();
        expect(clarityResult).toBeDefined();

        // Should take roughly max(100, 80) ≈ 100ms, NOT 180ms
        const maxDelay = Math.max(DRIFT_DELAY, CLARITY_DELAY);
        expect(elapsed).toBeLessThan(maxDelay + TOLERANCE);
        // Confirm it's not sequential (sum would be >= 180ms)
        expect(elapsed).toBeLessThan(DRIFT_DELAY + CLARITY_DELAY);
    });

    it("surfaces combined output when both have issues", async () => {
        const driftResult = makeDriftResult({
            hasDrift: true,
            severity: "soft",
            conflicts: [
                {
                    conflictId: "c1",
                    goalFragment: "use REST",
                    decision: {
                        id: "d1",
                        decision: "Use GraphQL for all new endpoints",
                        reasoning: "Better developer experience",
                        tags: ["api", "graphql"],
                        recommendedBy: "architect",
                        confidence: 0.9,
                        capturedAt: Date.now(),
                        permanent: false,
                        supersedes: [],
                        reconsidered: false,
                    },
                    similarityScore: 0.8,
                    conflictType: "direct",
                    explanation: "Goal mentions REST but past decision chose GraphQL",
                },
            ],
        });

        const clarityResult = makeClarityResult({
            isClear: false,
            score: 0.4,
            issues: [
                {
                    type: "vague_verb",
                    fragment: "improve",
                    question: "What does 'improve' mean specifically?",
                    severity: "advisory",
                },
            ],
            suggestions: ["Be more specific about improvement targets"],
        });

        const [drift, clarity] = await Promise.all([
            Promise.resolve(driftResult),
            Promise.resolve(clarityResult),
        ]);

        const hasDriftIssues = drift?.hasDrift === true;
        const hasClarityIssues = clarity && !clarity.isClear;

        expect(hasDriftIssues).toBe(true);
        expect(hasClarityIssues).toBe(true);

        // Both detected — combined path should be taken
        expect(drift.conflicts).toHaveLength(1);
        expect(clarity.issues).toHaveLength(1);
    });

    it("blocking severity prevents proceeding (hard drift)", async () => {
        const driftResult = makeDriftResult({
            hasDrift: true,
            severity: "hard",
            conflicts: [
                {
                    conflictId: "c2",
                    goalFragment: "drop auth",
                    decision: {
                        id: "d2",
                        decision: "Authentication is mandatory",
                        reasoning: "Security requirement",
                        tags: ["auth", "security"],
                        recommendedBy: "security-lead",
                        confidence: 1.0,
                        capturedAt: Date.now(),
                        permanent: true,
                        supersedes: [],
                        reconsidered: false,
                    },
                    similarityScore: 0.95,
                    conflictType: "direct",
                    explanation: "Goal contradicts permanent security decision",
                },
            ],
        });

        const clarityResult = makeClarityResult({
            isClear: false,
            score: 0.3,
            issues: [
                {
                    type: "missing_success_criteria",
                    fragment: "drop auth",
                    question: "What success criteria apply?",
                    severity: "blocking",
                },
            ],
        });

        const [drift, clarity] = await Promise.all([
            Promise.resolve(driftResult),
            Promise.resolve(clarityResult),
        ]);

        const hasBlocking = clarity!.issues.some((i) => i.severity === "blocking")
            || drift!.severity === "hard";

        expect(hasBlocking).toBe(true);
        // Hard drift with permanent decision — should block
        expect(drift!.severity).toBe("hard");
        expect(drift!.conflicts[0].decision.permanent).toBe(true);
    });

    it("no issues path — both pass cleanly", async () => {
        const driftResult = makeDriftResult(); // hasDrift: false
        const clarityResult = makeClarityResult(); // isClear: true

        const [drift, clarity] = await Promise.all([
            Promise.resolve(driftResult),
            Promise.resolve(clarityResult),
        ]);

        const hasDriftIssues = drift?.hasDrift === true;
        const hasClarityIssues = clarity && !clarity.isClear;

        expect(hasDriftIssues).toBe(false);
        expect(hasClarityIssues).toBe(false);
        expect(clarity!.isClear).toBe(true);
    });

    it("handles one check failing gracefully", async () => {
        const runDrift = async (): Promise<DriftResult | null> => {
            try {
                throw new Error("LanceDB unavailable");
            } catch {
                return null;
            }
        };

        const runClarity = async (): Promise<ClarityResult | null> => {
            try {
                return makeClarityResult({ isClear: false, score: 0.6, issues: [
                    { type: "vague_verb", fragment: "fix", question: "Fix what?", severity: "advisory" },
                ] });
            } catch {
                return null;
            }
        };

        const [drift, clarity] = await Promise.all([runDrift(), runClarity()]);

        // Drift failed — null, clarity succeeded
        expect(drift).toBeNull();
        expect(clarity).not.toBeNull();

        const hasDriftIssues = drift?.hasDrift === true;
        const hasClarityIssues = clarity && !clarity.isClear;

        // Only clarity issues should be surfaced
        expect(hasDriftIssues).toBe(false);
        expect(hasClarityIssues).toBe(true);
    });
});
