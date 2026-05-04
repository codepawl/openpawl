/**
 * Typed artifact schemas for crew sessions.
 *
 * Spec context: §4.6 (Typed Artifact Store) calls for a single envelope shape
 * with a discriminated `kind` field and a per-kind `payload`. The 8 kinds
 * cover the data exchanged across phases: planning output, phase summaries,
 * meeting transcripts, individual reflections, code reviews, test reports,
 * post-mortems, and compaction snapshots.
 *
 * The detailed payload shapes are not enumerated in the v0.4 spec text;
 * the structures below are anchored to the data fields referenced elsewhere
 * in the spec (e.g. §4.2 phase/task fields, §4.3 reflections, §5.5 meeting
 * synthesis) so future spec edits can converge on a stable contract.
 */

import { z } from "zod";

import { CrewPhaseSchema, CrewTaskSchema } from "../types.js";

export const ARTIFACT_KINDS = [
  "plan",
  "phase_summary",
  "meeting_notes",
  "reflection",
  "review",
  "test_report",
  "post_mortem",
  "phase_compaction",
] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// ── Per-kind payload schemas ────────────────────────────────────────────

/**
 * Per spec §4.6: PlanArtifact payload is the Planner's flat decomposition
 * — phases keep id/name/complexity_tier metadata, tasks are top-level
 * with phase_id back-reference. The Planner's reasoning lives in
 * `rationale`. Full task descriptions, status, file lists, etc. live on
 * the `CrewGraphState.phases[].tasks` runtime view, not here.
 */
export const PlanArtifactPayloadSchema = z.object({
  phases: z
    .array(
      CrewPhaseSchema.pick({
        id: true,
        name: true,
        complexity_tier: true,
      }),
    )
    .min(1),
  tasks: z.array(
    CrewTaskSchema.pick({
      id: true,
      phase_id: true,
      assigned_agent: true,
      depends_on: true,
    }),
  ),
  rationale: z.string(),
});
export type PlanArtifactPayload = z.infer<typeof PlanArtifactPayloadSchema>;

/**
 * Per spec §4.6. Phase outcome surface — what the next phase reads to
 * know what already happened, what the user sees on the phase summary
 * card, and what the meeting facilitator (next PR) inputs to its
 * synthesis.
 *
 * `key_decisions` and `agent_confidences` are populated by the
 * discussion meeting (next PR). Phase-executor lands them empty and
 * the meeting overlays them via `supersedes`.
 */
export const PhaseSummaryArtifactPayloadSchema = z.object({
  phase_id: z.string().min(1),
  tasks_completed: z.number().int().nonnegative(),
  tasks_failed: z.number().int().nonnegative(),
  tasks_blocked: z.number().int().nonnegative(),
  files_created: z.array(z.string()).default([]),
  files_modified: z.array(z.string()).default([]),
  key_decisions: z.array(z.string()).default([]),
  agent_confidences: z.record(z.string(), z.number().min(0).max(100)).default({}),
});
export type PhaseSummaryArtifactPayload = z.infer<
  typeof PhaseSummaryArtifactPayloadSchema
>;

export const MeetingNotesArtifactPayloadSchema = z.object({
  phase_id: z.string().min(1),
  achievements: z.array(z.string()).default([]),
  debating: z.array(z.string()).default([]),
  missing_perspective: z.string().optional(),
  proposed_next_phase: z.string().optional(),
  facilitator: z.string().min(1),
  reflection_artifact_ids: z.array(z.string()).default([]),
  transcript: z.string().optional(),
});
export type MeetingNotesArtifactPayload = z.infer<
  typeof MeetingNotesArtifactPayloadSchema
>;

export const ReflectionArtifactPayloadSchema = z.object({
  phase_id: z.string().min(1),
  agent_id: z.string().min(1),
  went_well: z.array(z.string()).default([]),
  went_poorly: z.array(z.string()).default([]),
  next_phase_focus: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(100),
});
export type ReflectionArtifactPayload = z.infer<
  typeof ReflectionArtifactPayloadSchema
>;

export const ReviewSeveritySchema = z.enum(["info", "warn", "error", "critical"]);
export const ReviewVerdictSchema = z.enum(["approve", "request_changes", "comment"]);

export const ReviewArtifactPayloadSchema = z.object({
  target_files: z.array(z.string()).default([]),
  findings: z
    .array(
      z.object({
        severity: ReviewSeveritySchema,
        file: z.string().optional(),
        line: z.number().int().nonnegative().optional(),
        message: z.string().min(1),
        suggestion: z.string().optional(),
      }),
    )
    .default([]),
  verdict: ReviewVerdictSchema,
  summary: z.string().min(1),
});
export type ReviewArtifactPayload = z.infer<typeof ReviewArtifactPayloadSchema>;

export const TestReportArtifactPayloadSchema = z.object({
  command: z.string().min(1),
  exit_code: z.number().int(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().default(0),
  duration_ms: z.number().int().nonnegative().optional(),
  failures: z
    .array(
      z.object({
        name: z.string(),
        file: z.string().optional(),
        message: z.string(),
      }),
    )
    .default([]),
  stdout_excerpt: z.string().optional(),
  stderr_excerpt: z.string().optional(),
});
export type TestReportArtifactPayload = z.infer<
  typeof TestReportArtifactPayloadSchema
>;

export const PostMortemArtifactPayloadSchema = z.object({
  goal: z.string().min(1),
  phases_completed: z.number().int().nonnegative(),
  outcome: z.enum(["success", "partial", "aborted", "failed"]),
  lessons: z.array(
    z.object({
      title: z.string().min(1),
      detail: z.string().min(1),
      category: z.string().optional(),
    }),
  ),
  recommended_followups: z.array(z.string()).default([]),
});
export type PostMortemArtifactPayload = z.infer<
  typeof PostMortemArtifactPayloadSchema
>;

export const PhaseCompactionArtifactPayloadSchema = z.object({
  source_phase_id: z.string().min(1),
  source_artifact_ids: z.array(z.string()).default([]),
  compressed_summary: z.string().min(1),
  retained_facts: z.array(z.string()).default([]),
  original_token_count: z.number().int().nonnegative().optional(),
  compressed_token_count: z.number().int().nonnegative().optional(),
});
export type PhaseCompactionArtifactPayload = z.infer<
  typeof PhaseCompactionArtifactPayloadSchema
>;

// ── Common envelope + discriminated union ───────────────────────────────

const baseEnvelope = {
  id: z.string().min(1),
  author_agent: z.string().min(1),
  phase_id: z.string().min(1).nullable(),
  created_at: z.number().int().nonnegative(),
  supersedes: z.string().min(1).nullable().default(null),
};

export const PlanArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("plan"),
  payload: PlanArtifactPayloadSchema,
});
export const PhaseSummaryArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("phase_summary"),
  payload: PhaseSummaryArtifactPayloadSchema,
});
export const MeetingNotesArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("meeting_notes"),
  payload: MeetingNotesArtifactPayloadSchema,
});
export const ReflectionArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("reflection"),
  payload: ReflectionArtifactPayloadSchema,
});
export const ReviewArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("review"),
  payload: ReviewArtifactPayloadSchema,
});
export const TestReportArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("test_report"),
  payload: TestReportArtifactPayloadSchema,
});
export const PostMortemArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("post_mortem"),
  payload: PostMortemArtifactPayloadSchema,
});
export const PhaseCompactionArtifactSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("phase_compaction"),
  payload: PhaseCompactionArtifactPayloadSchema,
});

export const ArtifactSchema = z.discriminatedUnion("kind", [
  PlanArtifactSchema,
  PhaseSummaryArtifactSchema,
  MeetingNotesArtifactSchema,
  ReflectionArtifactSchema,
  ReviewArtifactSchema,
  TestReportArtifactSchema,
  PostMortemArtifactSchema,
  PhaseCompactionArtifactSchema,
]);

export type Artifact = z.infer<typeof ArtifactSchema>;
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;
export type PhaseSummaryArtifact = z.infer<typeof PhaseSummaryArtifactSchema>;
export type MeetingNotesArtifact = z.infer<typeof MeetingNotesArtifactSchema>;
export type ReflectionArtifact = z.infer<typeof ReflectionArtifactSchema>;
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
export type TestReportArtifact = z.infer<typeof TestReportArtifactSchema>;
export type PostMortemArtifact = z.infer<typeof PostMortemArtifactSchema>;
export type PhaseCompactionArtifact = z.infer<typeof PhaseCompactionArtifactSchema>;

export type ArtifactId = string;

export type ArtifactByKind<K extends ArtifactKind> = Extract<Artifact, { kind: K }>;
