/**
 * Facilitator synthesis for the discussion meeting per spec §5.5.
 *
 * The Facilitator (Planner role, separate invocation) reads every
 * surviving Explorer reflection and produces the meeting markdown
 * matching the §5.5 template:
 *
 *   ## Phase {N} retrospective
 *   ### What we achieved
 *   - {synthesized agreement points}
 *   ### What we're debating
 *   - {divergent concerns}
 *   ### Missing perspective
 *   - {critical gap}
 *   ### Proposed next phase
 *   - {tasks with rationale}
 *
 * The parser does not transform the Facilitator's output — it only
 * verifies the markdown is non-trivial and contains the proposed-next-
 * phase header. Transformations would dilute the Facilitator's voice,
 * which is what the user actually reads.
 *
 * `buildFallbackSummary` is the deterministic template the orchestrator
 * uses when the Facilitator's output fails parse twice. It produces a
 * minimal but valid §5.5 markdown stitched from the structured
 * reflection data — never from an LLM call.
 */

import type { ReflectionArtifactPayload } from "../artifacts/types.js";
import type { CrewPhase } from "../types.js";

export type FacilitatorParseReason = "too_short" | "missing_proposal_section";

export type ParseFacilitatorResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: FacilitatorParseReason; message: string };

const MIN_FACILITATOR_LENGTH = 200;
const PROPOSAL_HEADER_RE = /(?:^|\n)#{2,4}\s*proposed\s+next\s+phase/i;

export function parseFacilitatorOutput(
  rawLLMOutput: string,
): ParseFacilitatorResult {
  const trimmed = rawLLMOutput.trim();
  if (trimmed.length < MIN_FACILITATOR_LENGTH) {
    return {
      ok: false,
      reason: "too_short",
      message: `facilitator output is ${trimmed.length} chars; expected at least ${MIN_FACILITATOR_LENGTH}`,
    };
  }
  if (!PROPOSAL_HEADER_RE.test(trimmed)) {
    return {
      ok: false,
      reason: "missing_proposal_section",
      message:
        "facilitator output is missing a 'Proposed next phase' section header (case-insensitive)",
    };
  }
  return { ok: true, markdown: trimmed };
}

export interface BuildFacilitatorPromptArgs {
  phase: CrewPhase;
  /** Reflections that survived the parse + sycophancy filters. */
  reflections: Array<{ agent_id: string; payload: ReflectionArtifactPayload }>;
  goal: string;
  /** Round 1 = first synthesis. Round 2 = post-RA-CR re-synthesis (Tier 3 only). */
  round: 1 | 2;
  /** Set on a parse-retry. */
  retry_hint?: string;
  /** Optional next-phase hint for the proposal section. */
  next_phase_name?: string;
}

function renderReflectionsBlock(
  reflections: BuildFacilitatorPromptArgs["reflections"],
): string {
  if (reflections.length === 0) return "(no reflections collected)";
  const blocks: string[] = [];
  for (const { agent_id, payload } of reflections) {
    const sections = [
      `## ${agent_id} (round ${payload.round}, confidence ${payload.confidence})`,
      payload.went_well.length > 0
        ? `- went well:\n${payload.went_well.map((s) => `  - ${s}`).join("\n")}`
        : "",
      payload.went_poorly.length > 0
        ? `- went poorly:\n${payload.went_poorly.map((s) => `  - ${s}`).join("\n")}`
        : "",
      payload.next_phase_focus.length > 0
        ? `- next-phase focus:\n${payload.next_phase_focus.map((s) => `  - ${s}`).join("\n")}`
        : "",
    ].filter(Boolean);
    blocks.push(sections.join("\n"));
  }
  return blocks.join("\n\n");
}

export function buildFacilitatorPrompt(args: BuildFacilitatorPromptArgs): string {
  const { phase, reflections, goal, round, retry_hint, next_phase_name } = args;
  const proposalAnchor = next_phase_name
    ? `Propose tasks for the next phase named '${next_phase_name}'.`
    : "Propose tasks for the next phase.";

  const sections = [
    `# Discussion meeting facilitator — phase '${phase.name}' (${phase.id})`,
    `## Goal\n\n${goal}`,
    `## Round\n\n${round === 1 ? "Round 1 synthesis." : "Round 2 (RA-CR) synthesis — reflections below are revised after critique."}`,
    `## Reflections collected\n\n${renderReflectionsBlock(reflections)}`,
    `## Output format

Produce markdown ONLY (no JSON, no code fences) matching exactly this template:

\`\`\`
## Phase ${phase.name} retrospective

### What we achieved
- {synthesized agreement point 1}
- {synthesized agreement point 2}

### What we're debating
- {divergent concern 1}
- {divergent concern 2}

### Missing perspective
- {critical gap}

### Proposed next phase
- {task 1 with one-line rationale}
- {task 2 with one-line rationale}
\`\`\`

# Hard constraints

- The "Proposed next phase" section header MUST appear verbatim (case-insensitive) — the parser rejects output without it.
- Total output must be at least 200 characters.
- Do NOT invent reflections that weren't supplied above.
- ${proposalAnchor}
- Identify exactly 2 top agreements, exactly 2 top divergences (or fewer if fewer existed), and exactly 1 missing perspective.`,
  ];

  if (retry_hint) {
    sections.push(`# Retry — your previous output was rejected\n\n${retry_hint}\n\nReturn corrected markdown only.`);
  }

  return sections.join("\n\n");
}

/**
 * Deterministic markdown summary used when the LLM Facilitator
 * synthesis fails parse twice. Stitches structured reflection data
 * into the §5.5 template so the meeting can still produce a valid
 * MeetingNotesArtifact and the run continues.
 */
export function buildFallbackSummary(args: {
  phase: CrewPhase;
  reflections: Array<{ agent_id: string; payload: ReflectionArtifactPayload }>;
  next_phase_name?: string;
}): string {
  const { phase, reflections, next_phase_name } = args;
  const went_wells = reflections.flatMap((r) => r.payload.went_well);
  const went_poorlys = reflections.flatMap((r) => r.payload.went_poorly);
  const next_focus = reflections.flatMap((r) => r.payload.next_phase_focus);

  const proposal =
    next_focus.length > 0
      ? next_focus.slice(0, 4).map((s) => `- ${s}`).join("\n")
      : `- (no specific proposals recorded — next phase '${next_phase_name ?? "TBD"}' starts as planned)`;

  const achievements =
    went_wells.length > 0
      ? went_wells.slice(0, 4).map((s) => `- ${s}`).join("\n")
      : "- (no positive observations recorded)";

  const debates =
    went_poorlys.length > 0
      ? went_poorlys.slice(0, 4).map((s) => `- ${s}`).join("\n")
      : "- (no concerns recorded)";

  const confidences = reflections
    .map((r) => `${r.agent_id}=${r.payload.confidence}`)
    .join(", ");
  const missing =
    reflections.length === 0
      ? "- no reflections collected — fall back to the original plan"
      : `- collected ${reflections.length} reflection(s); confidences: ${confidences || "n/a"}`;

  return `## Phase ${phase.name} retrospective

_Auto-generated fallback summary — Facilitator LLM synthesis failed parse twice; this template was built from the structured reflection data._

### What we achieved
${achievements}

### What we're debating
${debates}

### Missing perspective
${missing}

### Proposed next phase
${proposal}
`;
}
