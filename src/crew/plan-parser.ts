/**
 * Plan parser — parses Planner LLM output into CrewPhase[] / CrewTask[] (scaffold).
 *
 * Implementation lands in the planning PR (Prompt 6).
 */

import { NotImplementedError } from "./types.js";

export function parsePlan(_planJson: string): never {
  throw new NotImplementedError("plan-parser pending — see PR sequence after #105");
}
