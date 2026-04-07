/**
 * Onboarding module — first-run experience.
 */

// New onboarding system
export type {
  DetectedEnvironment,
  ProjectType,
  SetupResult,
  PromptSuggestion,
  FirstRunResult,
  OnboardError,
} from "./types.js";

export { detectEnvironment, maskApiKey } from "./env-detector.js";
export { writeInitialConfig, mergeIntoExistingConfig } from "./config-writer.js";
export { generateFirstPrompts } from "./first-prompt.js";
export { handleFirstRun } from "./first-run.js";
export { runSetup } from "./setup-flow.js";

// Legacy re-export for backward compatibility — delegates to new setup flow
export interface RunOnboardOptions {
  installDaemon?: boolean;
}

export async function runOnboard(_options?: RunOnboardOptions): Promise<void> {
  const { runSetup: setup } = await import("./setup-flow.js");
  await setup();
}
