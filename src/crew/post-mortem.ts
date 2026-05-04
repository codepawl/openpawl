/**
 * Crew post-mortem — end-of-session lessons learned (scaffold).
 *
 * Implementation lands alongside the artifact store (Prompt 4) — post-mortems
 * are persisted as `PostMortemArtifact` per spec §4.6.
 */

import { NotImplementedError, type CrewGraphState } from "./types.js";

export async function runCrewPostMortem(_state: CrewGraphState): Promise<never> {
  throw new NotImplementedError("crew post-mortem pending — see PR sequence after #105");
}
