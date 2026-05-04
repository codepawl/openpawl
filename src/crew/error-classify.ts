/**
 * Crew error classification — env vs agent_logic distinction (scaffold).
 *
 * Reuses the v0.3 classifier strategy described in spec §7.6. Implementation
 * lands in the phase-execution PR (Prompt 7).
 */

import { NotImplementedError } from "./types.js";

export type CrewErrorKind =
  | "env_command_not_found"
  | "env_missing_dep"
  | "env_perm"
  | "env_port_in_use"
  | "timeout"
  | "agent_logic"
  | "unknown";

export function classifyCrewError(_error: unknown): CrewErrorKind {
  throw new NotImplementedError("crew error-classify pending — see PR sequence after #105");
}
