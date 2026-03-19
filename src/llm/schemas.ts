/**
 * Structured output schemas for agent nodes.
 * Each schema defines the expected shape of an LLM response for a given agent.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Sprint Planning — coordinator sprint plan output
// ---------------------------------------------------------------------------

export const SprintPlanSchema = z.object({
  sprintGoal: z.string().describe("1-2 sentence sprint objective"),
  definitionOfSuccess: z
    .array(z.string())
    .min(1)
    .describe("Measurable criteria for sprint completion (3-6 items)"),
  teamAssignments: z
    .array(
      z.object({
        role: z.string().describe("Team role (e.g. software_engineer, qa_reviewer)"),
        bot: z.string().describe("Bot identifier (e.g. bot_0)"),
        focus: z.string().describe("Focus area for this assignment"),
      }),
    )
    .min(1)
    .describe("Which bot handles what focus area"),
});

export type SprintPlan = z.infer<typeof SprintPlanSchema>;

// ---------------------------------------------------------------------------
// Goal Decomposition — coordinator goal breakdown into subtasks
// ---------------------------------------------------------------------------

export const GoalDecompositionSchema = z.object({
  tasks: z
    .array(
      z.object({
        description: z.string().describe("Concrete subtask description"),
        assigned_to: z.string().describe("Bot id to assign this task to"),
        worker_tier: z
          .enum(["light", "heavy"])
          .describe("Worker tier — heavy only for browser/GUI tasks"),
        complexity: z
          .enum(["LOW", "MEDIUM", "HIGH", "ARCHITECTURE"])
          .describe("Task complexity level"),
        dependencies: z
          .array(z.number().int().nonnegative())
          .default([])
          .describe("0-based indices of prerequisite tasks in this array"),
      }),
    )
    .min(1)
    .describe("Decomposed subtasks (3-6 recommended)"),
});

export type GoalDecomposition = z.infer<typeof GoalDecompositionSchema>;

// ---------------------------------------------------------------------------
// Feasibility Check — planner validates task decomposition
// ---------------------------------------------------------------------------

export const FeasibilityCheckSchema = z.object({
  feasible: z.boolean().describe("Whether the decomposition is feasible as-is"),
  issues: z
    .array(z.string())
    .describe("Specific problems found (empty if feasible)"),
  suggestions: z
    .array(z.string())
    .describe("How to fix the decomposition (empty if feasible)"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence in the feasibility assessment (0-1)"),
});

export type FeasibilityCheck = z.infer<typeof FeasibilityCheckSchema>;

// ---------------------------------------------------------------------------
// Code Output — coder implementation result
// ---------------------------------------------------------------------------

export const CodeOutputSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().describe("Relative file path from workspace root"),
        content: z.string().describe("Full file content"),
        action: z
          .enum(["create", "update", "delete"])
          .describe("File operation to perform"),
      }),
    )
    .describe("Files created, modified, or deleted"),
  summary: z.string().describe("Brief description of changes made"),
  testsPassed: z
    .boolean()
    .optional()
    .describe("Whether the implementation passes its own tests"),
});

export type CodeOutput = z.infer<typeof CodeOutputSchema>;

// ---------------------------------------------------------------------------
// Code Review — reviewer verdict and feedback
// ---------------------------------------------------------------------------

export const CodeReviewSchema = z.object({
  verdict: z
    .enum(["approve", "request_changes", "reject"])
    .describe("Review outcome"),
  comments: z
    .array(
      z.object({
        file: z.string().describe("File path the comment refers to"),
        line: z.number().int().positive().optional().describe("Line number"),
        severity: z
          .enum(["critical", "major", "minor", "nit"])
          .describe("Issue severity"),
        message: z.string().describe("Review comment"),
      }),
    )
    .describe("Specific code review comments"),
  summary: z.string().describe("Overall review summary"),
  suggestedChanges: z
    .array(z.string())
    .optional()
    .describe("High-level change suggestions"),
});

export type CodeReview = z.infer<typeof CodeReviewSchema>;

// ---------------------------------------------------------------------------
// Drift Analysis — for future LLM-based drift detection
// ---------------------------------------------------------------------------

export const DriftAnalysisSchema = z.object({
  hasDrift: z.boolean().describe("Whether drift from the original goal was detected"),
  severity: z
    .enum(["none", "low", "medium", "high"])
    .describe("Drift severity level"),
  driftPoints: z
    .array(
      z.object({
        original: z.string().describe("What the original goal specified"),
        actual: z.string().describe("What is actually being done"),
        explanation: z.string().describe("Why this constitutes drift"),
      }),
    )
    .describe("Specific points of drift"),
  recommendation: z
    .string()
    .describe("Suggested corrective action, if any"),
});

export type DriftAnalysis = z.infer<typeof DriftAnalysisSchema>;

// ---------------------------------------------------------------------------
// Clarity Check — for future LLM-based clarity analysis
// ---------------------------------------------------------------------------

export const ClarityCheckSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Clarity score from 0 (very vague) to 1 (perfectly clear)"),
  issues: z
    .array(
      z.object({
        type: z
          .enum(["vague_verb", "missing_criteria", "ambiguous_scope", "unspecified_noun"])
          .describe("Category of clarity issue"),
        fragment: z.string().describe("The problematic text fragment"),
        suggestion: z.string().describe("How to make it clearer"),
      }),
    )
    .describe("Identified clarity issues"),
  rewrittenGoal: z
    .string()
    .optional()
    .describe("Suggested rewrite of the goal for better clarity"),
});

export type ClarityCheck = z.infer<typeof ClarityCheckSchema>;

// ---------------------------------------------------------------------------
// Confidence Score — for future LLM-based confidence assessment
// ---------------------------------------------------------------------------

export const ConfidenceScoreSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence score from 0 (no confidence) to 1 (fully confident)"),
  reasoning: z.string().describe("Explanation for the confidence level"),
  risks: z
    .array(z.string())
    .describe("Identified risks that lower confidence"),
  mitigations: z
    .array(z.string())
    .optional()
    .describe("Suggested mitigations for identified risks"),
});

export type ConfidenceScore = z.infer<typeof ConfidenceScoreSchema>;
