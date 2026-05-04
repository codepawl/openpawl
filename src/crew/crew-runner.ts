/**
 * CrewRunner — top-level multi-agent orchestrator (scaffold).
 *
 * v0.4 stub: emits `crew:start`, then throws NotImplementedError. The full
 * implementation (planning, phase execution, discussion meetings, artifact
 * store, single-writer locks, capability gate) lands in subsequent PRs per
 * the spec roadmap.
 */

import { EventEmitter } from "node:events";
import { NotImplementedError, type CrewRunOptions } from "./types.js";

export const CREW_RUNNER_PENDING_MESSAGE =
  "crew runner pending — see PR sequence after #105";

export class CrewRunner extends EventEmitter {
  async run(options: CrewRunOptions): Promise<never> {
    this.emit("crew:start", {
      goal: options.goal,
      crew_name: options.crew_name,
      workdir: options.workdir,
    });
    throw new NotImplementedError(CREW_RUNNER_PENDING_MESSAGE);
  }
}
