import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockLogger, mockAnalyzeClarity, mockGenerateQuestions, mockRewriteGoal, mockClackText, mockClackIsCancel } = vi.hoisted(() => ({
  mockLogger: {
    plain: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    agent: vi.fn(),
    plainLine: vi.fn(),
  },
  mockAnalyzeClarity: vi.fn(),
  mockGenerateQuestions: vi.fn().mockReturnValue([]),
  mockRewriteGoal: vi.fn().mockReturnValue("clarified goal"),
  mockClackText: vi.fn().mockResolvedValue("user answer"),
  mockClackIsCancel: vi.fn().mockReturnValue(false),
}));
vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("@/clarity/analyzer.js", () => ({
  analyzeClarity: (...args: unknown[]) => mockAnalyzeClarity(...args),
}));
vi.mock("@/clarity/questioner.js", () => ({
  generateQuestions: (...args: unknown[]) => mockGenerateQuestions(...args),
}));
vi.mock("@/clarity/rewriter.js", () => ({
  rewriteGoal: (...args: unknown[]) => mockRewriteGoal(...args),
}));
// Mock @clack/prompts for interactive --fix mode
vi.mock("@clack/prompts", () => ({
  text: (...args: unknown[]) => mockClackText(...args),
  isCancel: (...args: unknown[]) => mockClackIsCancel(...args),
}));

import { runClarityCommand } from "@/commands/clarity.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("teamclaw clarity", () => {
  describe("argument parsing", () => {
    it("--help shows usage without running analysis", async () => {
      await runClarityCommand(["--help"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("clarity");
      expect(mockAnalyzeClarity).not.toHaveBeenCalled();
    });

    it("-h also shows usage", async () => {
      await runClarityCommand(["-h"]);
      expect(mockAnalyzeClarity).not.toHaveBeenCalled();
    });

    it("no args shows usage", async () => {
      await runClarityCommand([]);
      expect(mockAnalyzeClarity).not.toHaveBeenCalled();
    });

    it("empty goal after filtering --fix shows error", async () => {
      await runClarityCommand(["--fix"]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("provide a goal"),
      );
    });
  });

  describe("clear goal analysis", () => {
    it("reports clear goal with score", async () => {
      mockAnalyzeClarity.mockReturnValue({
        isClear: true,
        score: 0.95,
        issues: [],
        suggestions: [],
      });

      await runClarityCommand(["Build a REST API with JWT auth"]);

      expect(mockAnalyzeClarity).toHaveBeenCalledWith("Build a REST API with JWT auth");
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("clear");
      expect(output).toContain("0.95");
    });
  });

  describe("unclear goal analysis", () => {
    const unclearResult = {
      isClear: false,
      score: 0.35,
      issues: [
        {
          type: "vague_verb",
          severity: "blocking" as const,
          fragment: "improve",
          question: "What specific improvement?",
        },
      ],
      suggestions: ["Be more specific about what to improve"],
    };

    it("shows issues and suggestions for unclear goal", async () => {
      mockAnalyzeClarity.mockReturnValue(unclearResult);

      await runClarityCommand(["Improve the API"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("0.35");
      expect(output).toContain("blocking");
      expect(output).toContain("improve");
      expect(output).toContain("Be more specific");
    });

    it("--fix triggers interactive clarification and shows improved score", async () => {
      mockAnalyzeClarity
        .mockReturnValueOnce(unclearResult)
        .mockReturnValueOnce({ isClear: true, score: 0.9, issues: [], suggestions: [] });

      mockGenerateQuestions.mockReturnValue([
        { question: "What to improve?", placeholder: "e.g., speed", issue: unclearResult.issues[0] },
      ]);
      mockRewriteGoal.mockReturnValue("Improve API response time by 50%");

      await runClarityCommand(["Improve the API", "--fix"]);

      // Verify full flow: ask question → rewrite → re-analyze
      expect(mockClackText).toHaveBeenCalledTimes(1);
      expect(mockRewriteGoal).toHaveBeenCalledWith(
        "Improve the API",
        expect.arrayContaining([
          expect.objectContaining({ answer: "user answer" }),
        ]),
      );
      expect(mockAnalyzeClarity).toHaveBeenCalledTimes(2);
      expect(mockAnalyzeClarity).toHaveBeenNthCalledWith(2, "Improve API response time by 50%");

      // Verify user sees the clarified goal and improved score
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("Improve API response time by 50%");
      expect(output).toContain("0.90");
    });

    it("--fix handles user cancellation gracefully", async () => {
      mockAnalyzeClarity.mockReturnValue(unclearResult);
      mockGenerateQuestions.mockReturnValue([
        { question: "What?", placeholder: "", issue: unclearResult.issues[0] },
      ]);
      mockClackIsCancel.mockReturnValue(true);

      await runClarityCommand(["Improve the API", "--fix"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("cancelled");
      expect(mockRewriteGoal).not.toHaveBeenCalled();
    });
  });

  describe("multi-word goal parsing", () => {
    it("joins multiple args as a single goal string", async () => {
      mockAnalyzeClarity.mockReturnValue({
        isClear: true,
        score: 0.9,
        issues: [],
        suggestions: [],
      });

      await runClarityCommand(["Build", "a", "REST", "API"]);

      expect(mockAnalyzeClarity).toHaveBeenCalledWith("Build a REST API");
    });

    it("strips --fix from the goal text", async () => {
      mockAnalyzeClarity.mockReturnValue({
        isClear: true,
        score: 0.9,
        issues: [],
        suggestions: [],
      });

      await runClarityCommand(["--fix", "Build", "API"]);

      expect(mockAnalyzeClarity).toHaveBeenCalledWith("Build API");
    });
  });
});
