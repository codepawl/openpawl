/**
 * Startup validation: fail fast when required settings are missing or invalid.
 * Uses Zod for config schema; does not replace runtime fallbacks (quota, task failed, etc.).
 */

import { z } from "zod";
import { llmHealthCheck } from "./llm-client.js";
import { getTeamTemplate } from "./team-templates.js";

export const LLM_UNAVAILABLE_MSG =
  "❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.";

const StartupConfigSchema = z.object({
  templateId: z.string().optional(),
  maxCycles: z.number().int().min(1).optional(),
  maxRuns: z.number().int().min(1).optional(),
});

export type ValidateStartupOptions = z.infer<typeof StartupConfigSchema>;

export type ValidateStartupResult =
  | { ok: true }
  | { ok: false; message: string };

export async function validateStartup(
  options?: ValidateStartupOptions
): Promise<ValidateStartupResult> {
  if (options !== undefined) {
    const parsed = StartupConfigSchema.safeParse(options);
    if (!parsed.success) {
      const msg = parsed.error.errors
        .map((e) => e.message)
        .join("; ") || "max_cycles and max_runs must be at least 1.";
      return { ok: false, message: msg };
    }
  }

  const llmOk = await llmHealthCheck();
  if (!llmOk) return { ok: false, message: LLM_UNAVAILABLE_MSG };

  const templateId = options?.templateId;
  if (templateId !== undefined && templateId !== "") {
    const template = getTeamTemplate(templateId);
    if (template === null) {
      return {
        ok: false,
        message: `Invalid team template: ${templateId}. Use game_dev, startup, or content.`,
      };
    }
  }

  return { ok: true };
}
