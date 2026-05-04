/**
 * Crew types — scaffold for v0.4 multi-agent mode.
 *
 * Minimal surface: just enough for the CrewRunner stub and CLI shim to compile.
 * Full schemas (CrewTask, CrewPhase, CrewManifest, AgentDefinition, artifacts,
 * locks, capability gate) land in subsequent PRs per the spec roadmap.
 */

export interface CrewGraphState {
  goal: string;
  mode: "crew";
  crew_name: string;
}

export interface CrewRunOptions {
  goal: string;
  crew_name: string;
  workdir: string;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
