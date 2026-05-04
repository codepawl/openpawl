/**
 * Sycophancy detector per spec §5.5.
 *
 * The hybrid meeting protocol depends on Explorer agents producing
 * genuinely independent views. If two agents emit reflections that hash
 * to the same first 100 chars after normalization, that's a strong
 * signal one or both are pattern-matching agreement to peers rather
 * than thinking through the phase. The spec calls for re-prompting
 * the duplicates with explicit disagreement instructions.
 *
 * Hashing strategy: lowercase + collapse-whitespace the
 * `went_well + went_poorly` text, take the first 100 chars, FNV-1a
 * 32-bit hash. We do NOT pull in `node:crypto` for this — content-addr
 * stability matters more than cryptographic strength, and an FNV is
 * fine for a 4-byte fingerprint over short normalized strings.
 *
 * `next_phase_focus` is intentionally excluded from the fingerprint:
 * agents legitimately propose similar next-phase directions ("write
 * tests", "refactor X") without being sycophantic — duplication there
 * isn't a useful signal. Sycophancy lives in the went-well / went-poorly
 * shape.
 */

import type { ReflectionArtifactPayload } from "../artifacts/types.js";

const HASH_PREFIX_LEN = 100;

interface HashableReflection {
  agent_id: string;
  went_well: string[];
  went_poorly: string[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function fnv1a32(str: string): string {
  // 32-bit FNV-1a — deterministic, no deps.
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function fingerprintReflection(reflection: HashableReflection): string {
  const combined = [...reflection.went_well, ...reflection.went_poorly].join(" ");
  const normalized = normalize(combined).slice(0, HASH_PREFIX_LEN);
  return fnv1a32(normalized);
}

export interface SycophancyDuplicate {
  hash: string;
  agent_ids: string[];
}

export interface SycophancyResult {
  duplicates: SycophancyDuplicate[];
  flagged: boolean;
}

export function detectSycophancy(
  reflections: ReflectionArtifactPayload[],
): SycophancyResult {
  const groups = new Map<string, string[]>();
  for (const r of reflections) {
    const fp = fingerprintReflection(r);
    const list = groups.get(fp) ?? [];
    list.push(r.agent_id);
    groups.set(fp, list);
  }
  const duplicates: SycophancyDuplicate[] = [];
  for (const [hash, agent_ids] of groups) {
    if (agent_ids.length >= 2) {
      duplicates.push({ hash, agent_ids });
    }
  }
  return {
    duplicates,
    flagged: duplicates.length > 0,
  };
}

export interface BuildAntiSycophancyRetryPromptArgs {
  /** The original reflection prompt that produced the duplicate. */
  original_prompt: string;
  /** Other agents' reflections, for the disagree-with-the-weakest instruction. */
  peer_reflections: Array<{ agent_id: string; payload: ReflectionArtifactPayload }>;
  /** This agent's id — excluded from peer_reflections in the prompt body. */
  this_agent_id: string;
}

export function buildAntiSycophancyRetryPrompt(
  args: BuildAntiSycophancyRetryPromptArgs,
): string {
  const peerLines = args.peer_reflections
    .filter((p) => p.agent_id !== args.this_agent_id)
    .map((p) => {
      const wp =
        p.payload.went_poorly.length > 0
          ? p.payload.went_poorly.slice(0, 2).join(" / ")
          : "(none cited)";
      const ww =
        p.payload.went_well.length > 0
          ? p.payload.went_well.slice(0, 2).join(" / ")
          : "(none cited)";
      return `- ${p.agent_id}: went_well="${ww}" · went_poorly="${wp}"`;
    })
    .join("\n");

  return `${args.original_prompt}

# Sycophancy retry — your previous reflection was too similar to a peer's

The meeting orchestrator hashed the first 100 chars of your went_well + went_poorly text and got a collision with another agent. Echoing peer agreement is the failure mode this protocol exists to prevent (spec §5.5).

Peer reflections seen this round:

${peerLines || "(no peers — this should not happen; revise based on your distinct role)"}

You must disagree with at least one peer perspective in your revised reflection.

Concretely:
- Identify the weakest claim in the peer reflections above and explain why it's wrong (overstated, missed evidence, wrong priority).
- Cite a fact from this phase's task outcomes that the peers did not.
- Avoid repeating any fragment of your previous answer verbatim.

Return corrected JSON only.`;
}
