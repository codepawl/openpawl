/**
 * Context compaction at phase boundary per spec §5.7.
 *
 * Trigger: at the start of each phase iteration, before phase execution
 * begins. The runner sums the byte counts of every persisted phase-
 * related artifact for completed phases, divides by the rough 4-chars-
 * per-token heuristic used elsewhere in the crew runtime, and fires
 * compaction when the estimate crosses
 * `threshold_ratio × model_context_window`.
 *
 * Compaction shape:
 *   - For every completed phase EXCEPT the most recent one (recency
 *     preserved verbatim per spec):
 *     - Skip if a `phase_compaction` artifact already supersedes the
 *       phase's `phase_summary` artifact (idempotent).
 *     - Spawn the Facilitator (planner agent_def) via runSubagent
 *       with a "summarize this phase in ≤200 words, preserve task
 *       IDs / file paths / key decisions" prompt.
 *     - Persist a PhaseCompactionArtifact via store.supersede so the
 *       phase summary's place in the supersession chain is taken by
 *       the compact form. The original artifact stays in the JSONL
 *       (append-only); only logical "current" supersedes.
 *
 * Failure modes:
 *   - Subagent throws: caught, debug-logged, that phase's compaction
 *     skipped, the run continues. We never abort a crew run because
 *     compaction failed.
 *   - Token-budget exhaustion: same — log + skip + continue.
 *   - Persistence fails (e.g. lock denied): same — log + skip.
 */

import { randomUUID } from "node:crypto";

import { debugLog } from "../debug/logger.js";
import {
  type ArtifactStore,
  type ArtifactStoreReader,
  type PhaseCompactionArtifact,
  type PhaseSummaryArtifact,
} from "./artifacts/index.js";
import {
  runSubagent as defaultRunSubagent,
  type RunSubagentArgs,
  type SubagentResult,
} from "./subagent-runner.js";
import { WriteLockManager } from "./write-lock.js";
import type { CrewManifest } from "./manifest/index.js";
import type { CrewPhase } from "./types.js";

export const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.8;
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;
const FACILITATOR_AGENT_ID = "planner";

const TOKEN_HEURISTIC = (text: string): number => Math.ceil(text.length / 4);

export interface CheckAndCompactArgs {
  phases: CrewPhase[];
  manifest: CrewManifest;
  artifact_store: ArtifactStore;
  write_lock_manager: WriteLockManager;
  session_id: string;
  /** The crew's max_tokens_per_task; compaction subagent gets a quarter of this. */
  max_tokens_per_task?: number;
  threshold_ratio?: number;
  /** Tokens-or-equivalent capacity. Defaults to 200k. Tests pass tiny values. */
  model_context_window?: number;
  runSubagentImpl?: (args: RunSubagentArgs) => Promise<SubagentResult>;
  signal?: AbortSignal;
}

export interface CompactedPhase {
  phase_id: string;
  before_token_count: number;
  after_token_count: number;
  compaction_artifact_id: string;
}

export interface CheckAndCompactResult {
  triggered: boolean;
  estimated_tokens_before: number;
  threshold_tokens: number;
  compacted_phases: CompactedPhase[];
  total_tokens_dropped: number;
  skipped_phases: Array<{ phase_id: string; reason: string }>;
}

function envThreshold(): number | undefined {
  const raw = process.env.OPENPAWL_COMPACT_AT;
  if (!raw) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  if (num > 0 && num <= 1) return num;
  return undefined;
}

/**
 * Estimate session-context tokens consumed by every persisted artifact
 * tied to the supplied completed phases. Cheap walk over the JSONL —
 * uses the same 4-chars-per-token heuristic as the budget tracker so
 * the two stay aligned.
 */
function estimateContextTokens(
  reader: ArtifactStoreReader,
  completed_phase_ids: string[],
): number {
  let total = 0;
  for (const phase_id of completed_phase_ids) {
    const artifacts = reader.list({ phase_id });
    for (const a of artifacts) {
      total += TOKEN_HEURISTIC(JSON.stringify(a.payload));
    }
  }
  return total;
}

function findOriginalSummary(
  reader: ArtifactStoreReader,
  phase_id: string,
): PhaseSummaryArtifact | null {
  const summaries = reader
    .list({ kind: "phase_summary", phase_id })
    .filter((a): a is PhaseSummaryArtifact => a.kind === "phase_summary");
  // Prefer the original (smallest created_at) — that's what the supersede
  // chain anchors against. Subsequent overlays superseded it.
  if (summaries.length === 0) return null;
  summaries.sort((a, b) => a.created_at - b.created_at);
  return summaries[0]!;
}

function isAlreadyCompacted(
  reader: ArtifactStoreReader,
  phase_id: string,
): boolean {
  const compactions = reader.list({ kind: "phase_compaction", phase_id });
  return compactions.length > 0;
}

function buildCompactionPrompt(args: {
  phase: CrewPhase;
  summary: PhaseSummaryArtifact;
  reflections: ArtifactStoreReader;
}): string {
  const taskOutcomes = args.phase.tasks
    .map(
      (t) =>
        `- ${t.id} [${t.assigned_agent}] ${t.status}` +
        (t.files_created.length || t.files_modified.length
          ? ` — files: ${[...t.files_created, ...t.files_modified].join(", ")}`
          : "") +
        (t.error ? ` — error: ${t.error.slice(0, 200)}` : ""),
    )
    .join("\n");

  const summaryPayload = args.summary.payload;
  return `# Compaction request — phase '${args.phase.name}' (${args.phase.id})

You are compacting a completed phase to reduce context-window pressure.
Produce markdown ≤ 200 words that preserves:
- task IDs that ran and their statuses
- file paths created or modified
- key decisions worth carrying forward

Drop conversational fluff, redundant agent commentary, and anything not actionable for later phases.

## Current PhaseSummaryArtifact

\`\`\`json
${JSON.stringify(
    {
      tasks_completed: summaryPayload.tasks_completed,
      tasks_failed: summaryPayload.tasks_failed,
      tasks_blocked: summaryPayload.tasks_blocked,
      files_created: summaryPayload.files_created,
      files_modified: summaryPayload.files_modified,
      key_decisions: summaryPayload.key_decisions,
    },
    null,
    2,
  )}
\`\`\`

## Task outcomes

${taskOutcomes || "(no tasks recorded)"}

# Output

Markdown ONLY, ≤ 200 words. No JSON, no code fences. Begin with a single line summary, then bullets.`;
}

export async function checkAndCompact(
  args: CheckAndCompactArgs,
): Promise<CheckAndCompactResult> {
  const thresholdRatio =
    args.threshold_ratio ?? envThreshold() ?? DEFAULT_COMPACT_THRESHOLD_RATIO;
  const contextWindow =
    args.model_context_window ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const thresholdTokens = Math.floor(thresholdRatio * contextWindow);
  const runSubagent = args.runSubagentImpl ?? defaultRunSubagent;

  const completedPhases = args.phases.filter((p) => p.status === "completed");
  const skipped: CheckAndCompactResult["skipped_phases"] = [];

  const beforeTokens = estimateContextTokens(
    args.artifact_store.reader(),
    completedPhases.map((p) => p.id),
  );

  if (beforeTokens <= thresholdTokens) {
    return {
      triggered: false,
      estimated_tokens_before: beforeTokens,
      threshold_tokens: thresholdTokens,
      compacted_phases: [],
      total_tokens_dropped: 0,
      skipped_phases: skipped,
    };
  }

  // Preserve the most recent completed phase verbatim. Compact all earlier ones.
  const compactionTargets = completedPhases.slice(0, -1);
  if (compactionTargets.length === 0) {
    return {
      triggered: true,
      estimated_tokens_before: beforeTokens,
      threshold_tokens: thresholdTokens,
      compacted_phases: [],
      total_tokens_dropped: 0,
      skipped_phases: completedPhases.map((p) => ({
        phase_id: p.id,
        reason: "only_one_completed_phase",
      })),
    };
  }

  const facilitator = args.manifest.agents.find(
    (a) => a.id === FACILITATOR_AGENT_ID,
  );
  if (!facilitator) {
    debugLog("warn", "crew", "compaction:no_facilitator", {
      data: { manifest_name: args.manifest.name },
    });
    return {
      triggered: true,
      estimated_tokens_before: beforeTokens,
      threshold_tokens: thresholdTokens,
      compacted_phases: [],
      total_tokens_dropped: 0,
      skipped_phases: compactionTargets.map((p) => ({
        phase_id: p.id,
        reason: "no_facilitator_agent",
      })),
    };
  }

  const compacted: CompactedPhase[] = [];
  let totalDropped = 0;
  const reader = args.artifact_store.reader();
  const taskBudget = args.max_tokens_per_task ?? 50_000;
  const subagentInput = Math.max(2_000, Math.floor(taskBudget / 4));

  for (const phase of compactionTargets) {
    if (isAlreadyCompacted(reader, phase.id)) {
      skipped.push({ phase_id: phase.id, reason: "already_compacted" });
      continue;
    }

    const summary = findOriginalSummary(reader, phase.id);
    if (!summary) {
      skipped.push({ phase_id: phase.id, reason: "no_phase_summary" });
      continue;
    }

    const phaseArtifacts = reader.list({ phase_id: phase.id });
    const beforePhaseTokens = phaseArtifacts.reduce(
      (sum, a) => sum + TOKEN_HEURISTIC(JSON.stringify(a.payload)),
      0,
    );
    const droppedToolResultCount = phase.tasks.reduce(
      (sum, t) => sum + (t.tool_calls?.length ?? 0),
      0,
    );

    let summaryMarkdown: string;
    try {
      const result = await runSubagent({
        agent_def: facilitator,
        prompt: buildCompactionPrompt({ phase, summary, reflections: reader }),
        artifact_reader: reader,
        depth: 0,
        parent_agent_id: "compaction",
        write_lock_manager: args.write_lock_manager,
        session_id: args.session_id,
        token_budget: {
          max_input: subagentInput,
          max_output: Math.max(1_000, Math.floor(subagentInput / 2)),
        },
        signal: args.signal,
      });
      summaryMarkdown = result.summary.trim();
      if (summaryMarkdown.length === 0) {
        skipped.push({
          phase_id: phase.id,
          reason: "empty_compaction_output",
        });
        continue;
      }
    } catch (err) {
      debugLog("warn", "crew", "compaction:subagent_failed", {
        data: { phase_id: phase.id },
        error: err instanceof Error ? err.message : String(err),
      });
      skipped.push({ phase_id: phase.id, reason: "subagent_failed" });
      continue;
    }

    const afterPhaseTokens = TOKEN_HEURISTIC(summaryMarkdown);
    const compaction: PhaseCompactionArtifact = {
      id: randomUUID(),
      kind: "phase_compaction",
      author_agent: FACILITATOR_AGENT_ID,
      phase_id: phase.id,
      created_at: Date.now(),
      supersedes: summary.id,
      payload: {
        compacted_phase_id: phase.id,
        original_summary_artifact_id: summary.id,
        summary_markdown: summaryMarkdown,
        dropped_tool_result_count: droppedToolResultCount,
        before_token_count: beforePhaseTokens,
        after_token_count: afterPhaseTokens,
      },
    };

    const writeResult = args.artifact_store.supersede(
      summary.id,
      compaction,
      FACILITATOR_AGENT_ID,
    );
    if (!writeResult.written) {
      debugLog("warn", "crew", "compaction:supersede_failed", {
        data: {
          phase_id: phase.id,
          reason: writeResult.reason,
          message: writeResult.message,
        },
      });
      skipped.push({ phase_id: phase.id, reason: "supersede_failed" });
      continue;
    }

    debugLog("info", "crew", "context_compacted", {
      data: {
        phase_id: phase.id,
        before_tokens: beforePhaseTokens,
        after_tokens: afterPhaseTokens,
        dropped_tool_result_count: droppedToolResultCount,
        artifact_id: compaction.id,
      },
    });

    compacted.push({
      phase_id: phase.id,
      before_token_count: beforePhaseTokens,
      after_token_count: afterPhaseTokens,
      compaction_artifact_id: compaction.id,
    });
    totalDropped += beforePhaseTokens - afterPhaseTokens;
  }

  return {
    triggered: true,
    estimated_tokens_before: beforeTokens,
    threshold_tokens: thresholdTokens,
    compacted_phases: compacted,
    total_tokens_dropped: totalDropped,
    skipped_phases: skipped,
  };
}
