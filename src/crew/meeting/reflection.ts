/**
 * Reflection prompt builder + parser per spec §5.5.
 *
 * At each phase boundary the meeting orchestrator gathers per-agent
 * "reflections" — short structured retrospectives the Facilitator then
 * synthesizes into the meeting notes. Each Explorer (every crew agent
 * except the Facilitator) is invoked through `runSubagent` with a
 * fresh context and a bounded prompt that asks for the four fields:
 *
 *   - went_well: string[]
 *   - went_poorly: string[]
 *   - next_phase_focus: string[]
 *   - confidence: number ∈ [0, 100]
 *
 * The parser layers safeJsonParse → Zod → cheap quality checks. The
 * "trivial" rejection mirrors the spec's anti-sycophancy guard: a
 * reflection with fewer than 3 sentences across the three list fields
 * is rejected so the agent re-prompts rather than passing through a
 * useless agreement-only blurb.
 */

import { z } from "zod";

import { safeJsonParse } from "../../utils/safe-json-parse.js";
import type { CrewPhase } from "../types.js";
import type { AgentDefinition } from "../manifest/types.js";
import type { ReflectionArtifactPayload } from "../artifacts/types.js";

/** Loose input shape — the parser only requires the four LLM-supplied fields. */
const RawReflectionSchema = z.object({
  went_well: z.array(z.string()).default([]),
  went_poorly: z.array(z.string()).default([]),
  next_phase_focus: z.array(z.string()).default([]),
  confidence: z.number(),
});
export type RawReflectionPayload = z.infer<typeof RawReflectionSchema>;

export type ReflectionParseReason =
  | "json_parse_failed"
  | "schema_invalid"
  | "trivial_reflection"
  | "invalid_confidence";

export type ParseReflectionResult =
  | { ok: true; payload: RawReflectionPayload }
  | { ok: false; reason: ReflectionParseReason; message: string };

/**
 * Count sentences across the three list fields by punctuation-split
 * fallback. A "sentence" is any non-empty fragment after splitting on
 * `.`, `!`, `?`, or newline. List items themselves are sentences too.
 */
function countSentences(payload: RawReflectionPayload): number {
  const all = [
    ...payload.went_well,
    ...payload.went_poorly,
    ...payload.next_phase_focus,
  ].join("\n");
  if (!all.trim()) return 0;
  return all
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

export function parseReflection(rawLLMOutput: string): ParseReflectionResult {
  const parsed = safeJsonParse<unknown>(rawLLMOutput);
  if (!parsed.parsed) {
    return {
      ok: false,
      reason: "json_parse_failed",
      message: `safeJsonParse failed: ${parsed.error}`,
    };
  }

  const validated = RawReflectionSchema.safeParse(parsed.data);
  if (!validated.success) {
    return {
      ok: false,
      reason: "schema_invalid",
      message: validated.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    };
  }

  const payload = validated.data;

  if (payload.confidence < 0 || payload.confidence > 100) {
    return {
      ok: false,
      reason: "invalid_confidence",
      message: `confidence ${payload.confidence} outside [0, 100]`,
    };
  }

  if (countSentences(payload) < 3) {
    return {
      ok: false,
      reason: "trivial_reflection",
      message:
        "reflection too short — combined went_well + went_poorly + next_phase_focus must total at least 3 sentences (spec §5.5 anti-sycophancy guard)",
    };
  }

  return { ok: true, payload };
}

export interface BuildReflectionPromptArgs {
  agent_def: AgentDefinition;
  phase: CrewPhase;
  goal: string;
  /** Brief summary of completed earlier phases — empty for the first boundary. */
  prior_phases_summary?: string;
  /** Optional retry hint the orchestrator passes on a re-prompt. */
  retry_hint?: string;
}

export function buildReflectionPrompt(args: BuildReflectionPromptArgs): string {
  const { agent_def, phase, goal, prior_phases_summary, retry_hint } = args;
  const taskOutcomes = phase.tasks
    .map(
      (t) =>
        `- ${t.id} [${t.assigned_agent}] ${t.status}: ${t.description}` +
        (t.error ? ` — error: ${t.error.slice(0, 200)}` : "") +
        (t.files_created.length || t.files_modified.length
          ? ` — files: ${[...t.files_created, ...t.files_modified].join(", ")}`
          : ""),
    )
    .join("\n");

  const sections = [
    `# Phase ${phase.name} retrospective — agent '${agent_def.id}'`,
    `## Goal\n\n${goal}`,
    `## What just happened in this phase\n\n${taskOutcomes || "(no tasks recorded)"}`,
  ];

  if (prior_phases_summary) {
    sections.push(`## Earlier phases (one-line each)\n\n${prior_phases_summary}`);
  }

  sections.push(`## Your role\n\n${agent_def.prompt.trim()}`);

  sections.push(
    `## Output format

Respond with JSON only — no prose, no code fences. Match this shape exactly:

\`\`\`
{
  "went_well": ["one or more short statements about what worked"],
  "went_poorly": ["one or more honest critiques of what didn't work"],
  "next_phase_focus": ["one or more specific suggestions for the next phase"],
  "confidence": <integer 0-100, your subjective confidence the goal will be reached on schedule>
}
\`\`\`

# Hard constraints

- Be specific. Reference task ids, file paths, or concrete failures from above. Avoid generic agreement.
- Combined sentence count across went_well + went_poorly + next_phase_focus must be at least 3 — anything shorter is rejected by the meeting orchestrator.
- Confidence must be an integer in [0, 100].
- Do NOT include a phase_id, agent_id, or round field — the orchestrator fills those in when persisting.`,
  );

  if (retry_hint) {
    sections.push(`# Retry — your previous output was rejected\n\n${retry_hint}\n\nReturn corrected JSON only.`);
  }

  return sections.join("\n\n");
}

/**
 * Helper for callers building artifact payloads: stamp the parsed
 * raw payload with phase_id, agent_id, and round.
 */
export function stampReflection(
  raw: RawReflectionPayload,
  args: { phase_id: string; agent_id: string; round: 1 | 2 },
): ReflectionArtifactPayload {
  return {
    phase_id: args.phase_id,
    agent_id: args.agent_id,
    went_well: raw.went_well,
    went_poorly: raw.went_poorly,
    next_phase_focus: raw.next_phase_focus,
    confidence: raw.confidence,
    round: args.round,
  };
}
