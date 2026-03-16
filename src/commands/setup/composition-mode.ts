/**
 * Setup wizard step for team composition mode selection.
 */

import { select, isCancel } from "@clack/prompts";
import type { WizardState } from "./connection.js";
import { handleCancel } from "./connection.js";

/** Extended wizard state with team_mode field. */
export interface CompositionWizardState extends WizardState {
  teamMode?: "manual" | "autonomous";
}

export async function stepCompositionMode(state: CompositionWizardState): Promise<void> {
  const modeInput = handleCancel(
    await select({
      message: "How should agents be selected for each run?",
      options: [
        {
          label: "Manual (default) — use the team template as-is",
          value: "manual" as const,
        },
        {
          label: "Autonomous — let the coordinator pick agents based on goal",
          value: "autonomous" as const,
        },
      ],
      initialValue: "manual" as const,
    }),
  );

  if (!isCancel(modeInput)) {
    state.teamMode = modeInput as "manual" | "autonomous";
  }
}
