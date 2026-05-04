/**
 * Discussion meeting orchestrator per spec §5.5 + §3 Decision 3.
 *
 * Tier-gated cost:
 *   - Tier 1: skipped entirely. Returns { skipped_reason: "tier_1" }.
 *   - Tier 2: single round.
 *       1. Each Explorer (every crew agent except the Facilitator)
 *          generates a reflection in isolation, in parallel.
 *       2. Reflections are parsed; one re-prompt per agent on failure.
 *       3. Sycophancy detector runs on surviving reflections; flagged
 *          duplicates get one anti-sycophancy re-prompt.
 *       4. Surviving reflections persist as ReflectionArtifact (round=1).
 *       5. Facilitator (Planner role) synthesizes; one parse retry,
 *          then deterministic fallback template.
 *       6. MeetingNotesArtifact persists (rounds_run=1).
 *
 *   - Tier 3: two-round RA-CR.
 *       Steps 1-4 as above.
 *       5. Facilitator emits structured per-agent critiques.
 *       6. Each Explorer revises their reflection given the critique;
 *          parsed + persisted as ReflectionArtifact (round=2).
 *       7. Final Facilitator synthesis on round-2 reflections; same
 *          parse + retry + fallback as Tier 2.
 *       8. MeetingNotesArtifact persists (rounds_run=2).
 *
 * The Facilitator is always the planner agent (read-only by manifest
 * defense in resolvePlannerAgent — that's why the planner is excluded
 * from the Explorer set here).
 *
 * All LLM calls flow through `runSubagent` so the capability gate,
 * write-lock, depth limit, and budget pre-flight all apply.
 */

import { randomUUID } from "node:crypto";

import { debugLog } from "../../debug/logger.js";
import {
  type ArtifactStore,
  type MeetingNotesArtifact,
  type ReflectionArtifact,
  type ReflectionArtifactPayload,
} from "../artifacts/index.js";
import {
  runSubagent as defaultRunSubagent,
  type RunSubagentArgs,
  type SubagentResult,
} from "../subagent-runner.js";
import { WriteLockManager } from "../write-lock.js";
import type { CrewManifest } from "../manifest/index.js";
import type { CrewPhase } from "../types.js";

import {
  buildFacilitatorPrompt,
  buildFallbackSummary,
  parseFacilitatorOutput,
} from "./facilitator.js";
import {
  buildReflectionPrompt,
  parseReflection,
  stampReflection,
  type RawReflectionPayload,
} from "./reflection.js";
import {
  buildAntiSycophancyRetryPrompt,
  detectSycophancy,
} from "./sycophancy.js";

export const FACILITATOR_AGENT_ID = "planner";

export type MeetingSkipReason =
  | "first_phase_boundary"
  | "last_phase"
  | "tier_1";

export interface MeetingResultSkipped {
  skipped_reason: MeetingSkipReason;
  meeting_notes_artifact_id: null;
  reflection_artifact_ids: never[];
}

export interface MeetingResultRun {
  skipped_reason: null;
  meeting_notes_artifact_id: string;
  reflection_artifact_ids: string[];
  rounds_run: 1 | 2;
  rejected_reflection_count: number;
  sycophancy_flagged: boolean;
}

export type MeetingResult = MeetingResultSkipped | MeetingResultRun;

export interface RunDiscussionMeetingArgs {
  prev_phase: CrewPhase | undefined;
  next_phase: CrewPhase | undefined;
  manifest: CrewManifest;
  goal: string;
  artifact_store: ArtifactStore;
  write_lock_manager: WriteLockManager;
  session_id: string;
  /** Brief summary lines for context — orchestrator builds, we just inject. */
  prior_phases_summary?: string;
  /** Per-call token budget cap. Defaults to spec §3 Decision 5 task cap. */
  max_tokens_per_task?: number;
  /** Test seam — defaults to the real {@link runSubagent}. */
  runSubagentImpl?: (args: RunSubagentArgs) => Promise<SubagentResult>;
  signal?: AbortSignal;
}

const DEFAULT_TASK_BUDGET = 50_000;
const REFLECTION_BUDGET_DIVISOR = 4;
const FACILITATOR_BUDGET_DIVISOR = 2;

interface ReflectionAttemptOutcome {
  agent_id: string;
  raw?: RawReflectionPayload;
  rejected_attempts: number;
  final_reason?: string;
}

async function gatherOneReflection(args: {
  agent_def: CrewManifest["agents"][number];
  prompt: string;
  retry_prompt_builder: (reason: string) => string;
  budget: number;
  reader: ArtifactStore;
  lockManager: WriteLockManager;
  sessionId: string;
  signal?: AbortSignal;
  runSubagent: (a: RunSubagentArgs) => Promise<SubagentResult>;
}): Promise<ReflectionAttemptOutcome> {
  let prompt = args.prompt;
  let rejected = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await args.runSubagent({
      agent_def: args.agent_def,
      prompt,
      artifact_reader: args.reader.reader(),
      depth: 0,
      parent_agent_id: "meeting",
      write_lock_manager: args.lockManager,
      session_id: args.sessionId,
      token_budget: {
        max_input: args.budget,
        max_output: Math.max(1_000, Math.floor(args.budget / 3)),
      },
      signal: args.signal,
    });
    const parsed = parseReflection(result.summary);
    if (parsed.ok) {
      return { agent_id: args.agent_def.id, raw: parsed.payload, rejected_attempts: rejected };
    }
    rejected += 1;
    debugLog("warn", "crew", "meeting:reflection_rejected", {
      data: {
        agent_id: args.agent_def.id,
        reason: parsed.reason,
        message: parsed.message,
        attempt,
      },
    });
    if (attempt === 2) {
      return {
        agent_id: args.agent_def.id,
        rejected_attempts: rejected,
        final_reason: parsed.reason,
      };
    }
    prompt = args.retry_prompt_builder(parsed.reason);
  }
  // Unreachable, but TS needs the return.
  return { agent_id: args.agent_def.id, rejected_attempts: rejected };
}

async function runFacilitatorWithRetry(args: {
  prompt_builder: (retry_hint?: string) => string;
  agent_def: CrewManifest["agents"][number];
  budget: number;
  reader: ArtifactStore;
  lockManager: WriteLockManager;
  sessionId: string;
  signal?: AbortSignal;
  runSubagent: (a: RunSubagentArgs) => Promise<SubagentResult>;
}): Promise<{ markdown: string; used_fallback: boolean; tokens_used: number }> {
  let tokens = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? args.prompt_builder() : args.prompt_builder(`previous attempt failed`);
    const result = await args.runSubagent({
      agent_def: args.agent_def,
      prompt,
      artifact_reader: args.reader.reader(),
      depth: 0,
      parent_agent_id: "meeting",
      write_lock_manager: args.lockManager,
      session_id: args.sessionId,
      token_budget: {
        max_input: args.budget,
        max_output: Math.max(2_000, Math.floor(args.budget / 2)),
      },
      signal: args.signal,
    });
    tokens += result.tokens_used;
    const parsed = parseFacilitatorOutput(result.summary);
    if (parsed.ok) {
      return { markdown: parsed.markdown, used_fallback: false, tokens_used: tokens };
    }
    debugLog("warn", "crew", "meeting:facilitator_retry", {
      data: { reason: parsed.reason, message: parsed.message, attempt },
    });
  }
  // Both attempts failed. Caller substitutes the deterministic fallback.
  return { markdown: "", used_fallback: true, tokens_used: tokens };
}

function persistReflection(
  store: ArtifactStore,
  payload: ReflectionArtifactPayload,
): string | null {
  const artifact: ReflectionArtifact = {
    id: randomUUID(),
    kind: "reflection",
    author_agent: payload.agent_id,
    phase_id: payload.phase_id,
    created_at: Date.now(),
    supersedes: null,
    payload,
  };
  const result = store.write(artifact, payload.agent_id);
  if (!result.written) {
    debugLog("error", "crew", "meeting:reflection_write_failed", {
      data: { reason: result.reason, message: result.message, agent_id: payload.agent_id },
    });
    return null;
  }
  return artifact.id;
}

function persistMeetingNotes(args: {
  store: ArtifactStore;
  phase_id: string;
  next_phase_id: string | null;
  tier: CrewPhase["complexity_tier"];
  rounds_run: 1 | 2;
  markdown: string;
  reflection_artifact_ids: string[];
  rejected_reflection_count: number;
  sycophancy_flagged: boolean;
}): string | null {
  const artifact: MeetingNotesArtifact = {
    id: randomUUID(),
    kind: "meeting_notes",
    author_agent: FACILITATOR_AGENT_ID,
    phase_id: args.phase_id,
    created_at: Date.now(),
    supersedes: null,
    payload: {
      phase_id: args.phase_id,
      next_phase_id: args.next_phase_id,
      tier: args.tier,
      rounds_run: args.rounds_run,
      markdown: args.markdown,
      reflection_artifact_ids: args.reflection_artifact_ids,
      rejected_reflection_count: args.rejected_reflection_count,
      sycophancy_flagged: args.sycophancy_flagged,
    },
  };
  const result = args.store.write(artifact, FACILITATOR_AGENT_ID);
  if (!result.written) {
    debugLog("error", "crew", "meeting:meeting_notes_write_failed", {
      data: { reason: result.reason, message: result.message },
    });
    return null;
  }
  return artifact.id;
}

export async function runDiscussionMeeting(
  args: RunDiscussionMeetingArgs,
): Promise<MeetingResult> {
  if (!args.prev_phase) {
    return {
      skipped_reason: "first_phase_boundary",
      meeting_notes_artifact_id: null,
      reflection_artifact_ids: [] as never[],
    };
  }
  if (!args.next_phase) {
    return {
      skipped_reason: "last_phase",
      meeting_notes_artifact_id: null,
      reflection_artifact_ids: [] as never[],
    };
  }
  if (args.prev_phase.complexity_tier === "1") {
    debugLog("info", "crew", "meeting:tier_1_skipped", {
      data: { phase_id: args.prev_phase.id },
    });
    return {
      skipped_reason: "tier_1",
      meeting_notes_artifact_id: null,
      reflection_artifact_ids: [] as never[],
    };
  }

  const phase = args.prev_phase;
  const next_phase = args.next_phase;
  const tier = phase.complexity_tier;
  const taskBudget = args.max_tokens_per_task ?? DEFAULT_TASK_BUDGET;
  const reflectionBudget = Math.max(2_000, Math.floor(taskBudget / REFLECTION_BUDGET_DIVISOR));
  const facilitatorBudget = Math.max(4_000, Math.floor(taskBudget / FACILITATOR_BUDGET_DIVISOR));
  const runSubagent = args.runSubagentImpl ?? defaultRunSubagent;

  const explorers = args.manifest.agents.filter((a) => a.id !== FACILITATOR_AGENT_ID);
  const facilitator = args.manifest.agents.find((a) => a.id === FACILITATOR_AGENT_ID);
  if (!facilitator) {
    debugLog("error", "crew", "meeting:no_facilitator", {
      data: { manifest_name: args.manifest.name },
    });
    return {
      skipped_reason: "tier_1",
      meeting_notes_artifact_id: null,
      reflection_artifact_ids: [] as never[],
    };
  }

  debugLog("info", "crew", "meeting:start", {
    data: {
      phase_id: phase.id,
      tier,
      agent_count: explorers.length,
      session_id: args.session_id,
    },
  });

  // ── Round 1: parallel reflections with one re-prompt on parse failure ──
  const round1Settled = await Promise.allSettled(
    explorers.map((agent_def) => {
      const reflectionPrompt = buildReflectionPrompt({
        agent_def,
        phase,
        goal: args.goal,
        prior_phases_summary: args.prior_phases_summary,
      });
      return gatherOneReflection({
        agent_def,
        prompt: reflectionPrompt,
        retry_prompt_builder: (reason) =>
          buildReflectionPrompt({
            agent_def,
            phase,
            goal: args.goal,
            prior_phases_summary: args.prior_phases_summary,
            retry_hint: `previous: ${reason}`,
          }),
        budget: reflectionBudget,
        reader: args.artifact_store,
        lockManager: args.write_lock_manager,
        sessionId: args.session_id,
        signal: args.signal,
        runSubagent,
      });
    }),
  );

  let rejectedCount = 0;
  let surviving: Array<{
    agent_id: string;
    payload: ReflectionArtifactPayload;
  }> = [];

  for (let i = 0; i < explorers.length; i++) {
    const settled = round1Settled[i]!;
    const explorer = explorers[i]!;
    if (settled.status === "rejected") {
      rejectedCount += 1;
      debugLog("warn", "crew", "meeting:reflection_rejected", {
        data: {
          agent_id: explorer.id,
          reason: "subagent_threw",
          message: String(settled.reason),
          attempt: 1,
        },
      });
      continue;
    }
    const outcome = settled.value;
    if (!outcome.raw) {
      rejectedCount += outcome.rejected_attempts;
      continue;
    }
    rejectedCount += outcome.rejected_attempts;
    surviving.push({
      agent_id: explorer.id,
      payload: stampReflection(outcome.raw, {
        phase_id: phase.id,
        agent_id: explorer.id,
        round: 1,
      }),
    });
  }

  // ── Sycophancy detection + one anti-sycophancy retry ──
  let sycophancyFlagged = false;
  if (surviving.length >= 2) {
    const detection = detectSycophancy(surviving.map((s) => s.payload));
    if (detection.flagged) {
      sycophancyFlagged = true;
      debugLog("warn", "crew", "meeting:sycophancy_detected", {
        data: { duplicate_groups: detection.duplicates },
      });
      const flaggedAgentIds = new Set(
        detection.duplicates.flatMap((d) => d.agent_ids),
      );
      // Re-prompt every agent in any duplicate group, in parallel.
      const retrySettled = await Promise.allSettled(
        surviving
          .filter((s) => flaggedAgentIds.has(s.agent_id))
          .map((s) => {
            const agent_def = explorers.find((a) => a.id === s.agent_id)!;
            const original = buildReflectionPrompt({
              agent_def,
              phase,
              goal: args.goal,
              prior_phases_summary: args.prior_phases_summary,
            });
            const retryPrompt = buildAntiSycophancyRetryPrompt({
              original_prompt: original,
              peer_reflections: surviving,
              this_agent_id: s.agent_id,
            });
            return gatherOneReflection({
              agent_def,
              prompt: retryPrompt,
              retry_prompt_builder: () => retryPrompt,
              budget: reflectionBudget,
              reader: args.artifact_store,
              lockManager: args.write_lock_manager,
              sessionId: args.session_id,
              signal: args.signal,
              runSubagent,
            });
          }),
      );
      const flaggedAgents = surviving.filter((s) => flaggedAgentIds.has(s.agent_id));
      // Replace their payloads with the retried ones (when successful).
      for (let i = 0; i < flaggedAgents.length; i++) {
        const settled = retrySettled[i]!;
        if (settled.status === "fulfilled" && settled.value.raw) {
          const idx = surviving.findIndex(
            (s) => s.agent_id === flaggedAgents[i]!.agent_id,
          );
          if (idx !== -1) {
            surviving[idx] = {
              agent_id: flaggedAgents[i]!.agent_id,
              payload: stampReflection(settled.value.raw, {
                phase_id: phase.id,
                agent_id: flaggedAgents[i]!.agent_id,
                round: 1,
              }),
            };
          }
        } else {
          // Retry failed — drop the flagged reflection rather than persist a duplicate.
          surviving = surviving.filter(
            (s) => s.agent_id !== flaggedAgents[i]!.agent_id,
          );
          rejectedCount += 1;
        }
      }
    }
  }

  // ── Persist round-1 reflections ──
  const reflectionArtifactIds: string[] = [];
  for (const s of surviving) {
    const id = persistReflection(args.artifact_store, s.payload);
    if (id) reflectionArtifactIds.push(id);
  }

  // ── Tier 3: round-2 RA-CR (revise reflections after critique) ──
  let rounds_run: 1 | 2 = 1;
  if (tier === "3" && surviving.length >= 1) {
    rounds_run = 2;
    const round2Settled = await Promise.allSettled(
      surviving.map((s) => {
        const agent_def = explorers.find((a) => a.id === s.agent_id)!;
        // Per-agent critique: cast all peers' reflections back at this agent
        // and ask for a revised reflection. This is the "RA-CR" essence
        // — recall + critique + revise — without an extra LLM round trip.
        const peerLines = surviving
          .filter((p) => p.agent_id !== s.agent_id)
          .map(
            (p) =>
              `- ${p.agent_id}: went_well=${JSON.stringify(p.payload.went_well)}, went_poorly=${JSON.stringify(p.payload.went_poorly)}`,
          )
          .join("\n");
        const round2Prompt = `${buildReflectionPrompt({
          agent_def,
          phase,
          goal: args.goal,
          prior_phases_summary: args.prior_phases_summary,
        })}

# Round 2 (RA-CR) — revise your earlier reflection

Your round-1 reflection:
- went_well: ${JSON.stringify(s.payload.went_well)}
- went_poorly: ${JSON.stringify(s.payload.went_poorly)}
- next_phase_focus: ${JSON.stringify(s.payload.next_phase_focus)}

Peer round-1 reflections:
${peerLines || "(no peers)"}

Revise your reflection given the peer perspectives above. Disagree with at least one peer claim and cite a phase fact the peers missed. Return corrected JSON only, matching the same schema.`;
        return gatherOneReflection({
          agent_def,
          prompt: round2Prompt,
          retry_prompt_builder: (reason) => `${round2Prompt}\n\nprevious: ${reason}`,
          budget: reflectionBudget,
          reader: args.artifact_store,
          lockManager: args.write_lock_manager,
          sessionId: args.session_id,
          signal: args.signal,
          runSubagent,
        });
      }),
    );

    const round2Surviving: typeof surviving = [];
    for (let i = 0; i < surviving.length; i++) {
      const settled = round2Settled[i]!;
      const original = surviving[i]!;
      if (settled.status === "fulfilled" && settled.value.raw) {
        const stamped = stampReflection(settled.value.raw, {
          phase_id: phase.id,
          agent_id: original.agent_id,
          round: 2,
        });
        const id = persistReflection(args.artifact_store, stamped);
        if (id) {
          reflectionArtifactIds.push(id);
          round2Surviving.push({ agent_id: original.agent_id, payload: stamped });
        }
      } else {
        rejectedCount += 1;
      }
    }
    if (round2Surviving.length > 0) surviving = round2Surviving;
  }

  // ── Facilitator synthesis ──
  const facilitatorOutcome = await runFacilitatorWithRetry({
    prompt_builder: (retry_hint) =>
      buildFacilitatorPrompt({
        phase,
        reflections: surviving,
        goal: args.goal,
        round: rounds_run,
        retry_hint,
        next_phase_name: next_phase.name,
      }),
    agent_def: facilitator,
    budget: facilitatorBudget,
    reader: args.artifact_store,
    lockManager: args.write_lock_manager,
    sessionId: args.session_id,
    signal: args.signal,
    runSubagent,
  });

  let markdown = facilitatorOutcome.markdown;
  if (facilitatorOutcome.used_fallback) {
    debugLog("warn", "crew", "meeting:facilitator_fallback", {
      data: { phase_id: phase.id, reflection_count: surviving.length },
    });
    markdown = buildFallbackSummary({
      phase,
      reflections: surviving,
      next_phase_name: next_phase.name,
    });
  }

  const meetingId = persistMeetingNotes({
    store: args.artifact_store,
    phase_id: phase.id,
    next_phase_id: next_phase.id,
    tier,
    rounds_run,
    markdown,
    reflection_artifact_ids: reflectionArtifactIds,
    rejected_reflection_count: rejectedCount,
    sycophancy_flagged: sycophancyFlagged,
  });

  if (!meetingId) {
    // Persistence failed — return a synthetic id so caller can detect, but
    // still mark "not skipped" since the orchestrator did run the work.
    return {
      skipped_reason: null,
      meeting_notes_artifact_id: "<write_failed>",
      reflection_artifact_ids: reflectionArtifactIds,
      rounds_run,
      rejected_reflection_count: rejectedCount,
      sycophancy_flagged: sycophancyFlagged,
    };
  }

  debugLog("info", "crew", "meeting:done", {
    data: {
      meeting_artifact_id: meetingId,
      reflection_count: reflectionArtifactIds.length,
      rejected_count: rejectedCount,
      sycophancy_flagged: sycophancyFlagged,
      rounds_run,
      session_id: args.session_id,
    },
  });

  return {
    skipped_reason: null,
    meeting_notes_artifact_id: meetingId,
    reflection_artifact_ids: reflectionArtifactIds,
    rounds_run,
    rejected_reflection_count: rejectedCount,
    sycophancy_flagged: sycophancyFlagged,
  };
}
