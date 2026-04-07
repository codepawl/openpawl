import { ok, err, type Result } from "neverthrow";
import { runSetup } from "./setup-flow.js";
import type { FirstRunResult, OnboardError } from "./types.js";

export async function handleFirstRun(): Promise<Result<FirstRunResult, OnboardError>> {
  if (!process.stdout.isTTY) {
    return err({ type: "not_interactive", message: "OpenPawl setup requires an interactive terminal. Run: openpawl setup" });
  }

  try {
    await runSetup();
    return ok({
      configPath: "~/.openpawl/config.json",
      isNewSetup: true,
      isExistingConfig: false,
      environment: {} as any,
      suggestions: [],
    });
  } catch {
    return err({ type: "cancelled", message: "Setup cancelled" });
  }
}
