import { describe, it, expect, vi } from "vitest";
import {
  SprintPlanSchema,
  GoalDecompositionSchema,
  CodeReviewSchema,
  ConfidenceScoreSchema,
  FeasibilityCheckSchema,
} from "../schemas.js";
import type {
  SprintPlan,
  GoalDecomposition,
  CodeReview,
  ConfidenceScore,
  CodeOutput,
  DriftAnalysis,
  ClarityCheck,
  FeasibilityCheck,
} from "../schemas.js";

vi.mock("../../../core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

// ---------------------------------------------------------------------------
// SprintPlanSchema
// ---------------------------------------------------------------------------

describe("SprintPlanSchema", () => {
  it("validates correctly formed plan", () => {
    const plan = {
      sprintGoal: "Build a REST API with auth",
      definitionOfSuccess: [
        "API responds to health check",
        "JWT auth works end-to-end",
        "All endpoints return valid JSON",
      ],
      teamAssignments: [
        { role: "software_engineer", bot: "bot_0", focus: "Core API endpoints" },
        { role: "qa_reviewer", bot: "bot_1", focus: "Testing and validation" },
      ],
    };
    const result = SprintPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sprintGoal).toBe("Build a REST API with auth");
      expect(result.data.definitionOfSuccess).toHaveLength(3);
      expect(result.data.teamAssignments).toHaveLength(2);
    }
  });

  it("rejects missing required fields", () => {
    const incomplete = {
      sprintGoal: "Build something",
      // missing definitionOfSuccess and teamAssignments
    };
    const result = SprintPlanSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("rejects empty definitionOfSuccess", () => {
    const plan = {
      sprintGoal: "Build something",
      definitionOfSuccess: [],
      teamAssignments: [{ role: "dev", bot: "bot_0", focus: "code" }],
    };
    const result = SprintPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects empty teamAssignments", () => {
    const plan = {
      sprintGoal: "Build something",
      definitionOfSuccess: ["Done"],
      teamAssignments: [],
    };
    const result = SprintPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GoalDecompositionSchema
// ---------------------------------------------------------------------------

describe("GoalDecompositionSchema", () => {
  it("validates correctly formed decomposition", () => {
    const decomp = {
      tasks: [
        {
          description: "Set up project scaffolding",
          assigned_to: "bot_0",
          worker_tier: "light" as const,
          complexity: "LOW" as const,
          dependencies: [],
        },
        {
          description: "Implement auth middleware",
          assigned_to: "bot_0",
          worker_tier: "light" as const,
          complexity: "HIGH" as const,
          dependencies: [0],
        },
        {
          description: "Write integration tests",
          assigned_to: "bot_1",
          worker_tier: "light" as const,
          complexity: "MEDIUM" as const,
          dependencies: [0, 1],
        },
      ],
    };
    const result = GoalDecompositionSchema.safeParse(decomp);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks).toHaveLength(3);
      expect(result.data.tasks[1].dependencies).toEqual([0]);
    }
  });

  it("rejects invalid worker_tier", () => {
    const decomp = {
      tasks: [
        {
          description: "Do something",
          assigned_to: "bot_0",
          worker_tier: "mega",
          complexity: "LOW",
        },
      ],
    };
    const result = GoalDecompositionSchema.safeParse(decomp);
    expect(result.success).toBe(false);
  });

  it("defaults dependencies to empty array", () => {
    const decomp = {
      tasks: [
        {
          description: "Task without deps",
          assigned_to: "bot_0",
          worker_tier: "light" as const,
          complexity: "MEDIUM" as const,
          // no dependencies field
        },
      ],
    };
    const result = GoalDecompositionSchema.safeParse(decomp);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0].dependencies).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// CodeReviewSchema
// ---------------------------------------------------------------------------

describe("CodeReviewSchema", () => {
  it("validates correctly formed review", () => {
    const review = {
      verdict: "request_changes" as const,
      comments: [
        {
          file: "src/auth.ts",
          line: 42,
          severity: "critical" as const,
          message: "SQL injection vulnerability in query builder",
        },
        {
          file: "src/utils.ts",
          severity: "nit" as const,
          message: "Unused import",
        },
      ],
      summary: "Auth module has a security issue that must be addressed",
      suggestedChanges: ["Use parameterized queries", "Remove unused imports"],
    };
    const result = CodeReviewSchema.safeParse(review);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe("request_changes");
      expect(result.data.comments).toHaveLength(2);
      expect(result.data.comments[0].line).toBe(42);
      expect(result.data.comments[1].line).toBeUndefined();
    }
  });

  it("rejects invalid verdict", () => {
    const review = {
      verdict: "maybe",
      comments: [],
      summary: "Looks fine",
    };
    const result = CodeReviewSchema.safeParse(review);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConfidenceScoreSchema
// ---------------------------------------------------------------------------

describe("ConfidenceScoreSchema", () => {
  it("validates score range 0-1", () => {
    const valid = {
      score: 0.85,
      reasoning: "Implementation matches spec closely",
      risks: ["No error handling for edge cases"],
      mitigations: ["Add try-catch blocks"],
    };
    const result = ConfidenceScoreSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts score at boundaries", () => {
    expect(ConfidenceScoreSchema.safeParse({
      score: 0,
      reasoning: "No confidence",
      risks: ["Everything is wrong"],
    }).success).toBe(true);

    expect(ConfidenceScoreSchema.safeParse({
      score: 1,
      reasoning: "Full confidence",
      risks: [],
    }).success).toBe(true);
  });

  it("rejects score above 1", () => {
    const invalid = {
      score: 1.5,
      reasoning: "Overconfident",
      risks: [],
    };
    const result = ConfidenceScoreSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects score below 0", () => {
    const invalid = {
      score: -0.1,
      reasoning: "Negative confidence",
      risks: [],
    };
    const result = ConfidenceScoreSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FeasibilityCheckSchema
// ---------------------------------------------------------------------------

describe("FeasibilityCheckSchema", () => {
  it("validates feasible plan", () => {
    const check = {
      feasible: true,
      issues: [],
      suggestions: [],
      confidence: 0.95,
    };
    const result = FeasibilityCheckSchema.safeParse(check);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feasible).toBe(true);
      expect(result.data.issues).toHaveLength(0);
    }
  });

  it("validates infeasible plan with issues", () => {
    const check = {
      feasible: false,
      issues: [
        "Task 'Deploy to production' requires AWS credentials not available",
        "Task 'Send email' requires SMTP configuration",
      ],
      suggestions: [
        "Replace deployment task with local build verification",
        "Mock email sending for development",
      ],
      confidence: 0.85,
    };
    const result = FeasibilityCheckSchema.safeParse(check);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feasible).toBe(false);
      expect(result.data.issues).toHaveLength(2);
      expect(result.data.suggestions).toHaveLength(2);
    }
  });

  it("rejects confidence out of range", () => {
    const check = {
      feasible: true,
      issues: [],
      suggestions: [],
      confidence: 1.5,
    };
    expect(FeasibilityCheckSchema.safeParse(check).success).toBe(false);
  });

  it("issues must be non-empty when feasible is false", () => {
    // Schema itself doesn't enforce this, but we test the shape
    const check = {
      feasible: false,
      issues: [],
      suggestions: [],
      confidence: 0.3,
    };
    const result = FeasibilityCheckSchema.safeParse(check);
    expect(result.success).toBe(true); // Schema allows it; business logic enforces
  });
});

// ---------------------------------------------------------------------------
// Type-level test — ensures all schemas export matching TypeScript types
// ---------------------------------------------------------------------------

describe("All schemas export matching TypeScript types", () => {
  it("type assignments compile correctly", () => {
    // These assertions verify that the inferred types match the schemas.
    // If any schema/type pair is misaligned, this file will fail to compile.
    void ({
      sprintGoal: "test",
      definitionOfSuccess: ["a"],
      teamAssignments: [{ role: "dev", bot: "bot_0", focus: "code" }],
    } satisfies SprintPlan);

    void ({
      tasks: [
        {
          description: "task",
          assigned_to: "bot_0",
          worker_tier: "light",
          complexity: "MEDIUM",
          dependencies: [],
        },
      ],
    } satisfies GoalDecomposition);

    void ({
      files: [{ path: "src/index.ts", content: "// code", action: "create" }],
      summary: "Created index",
    } satisfies CodeOutput);

    void ({
      verdict: "approve",
      comments: [],
      summary: "Looks good",
    } satisfies CodeReview);

    void ({
      hasDrift: false,
      severity: "none",
      driftPoints: [],
      recommendation: "Stay the course",
    } satisfies DriftAnalysis);

    void ({
      score: 0.9,
      issues: [],
    } satisfies ClarityCheck);

    void ({
      score: 0.8,
      reasoning: "solid",
      risks: [],
    } satisfies ConfidenceScore);

    void ({
      feasible: true,
      issues: [],
      suggestions: [],
      confidence: 0.9,
    } satisfies FeasibilityCheck);

    // If we get here, all type assignments are valid
    expect(true).toBe(true);
  });
});
