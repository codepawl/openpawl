/**
 * Advanced settings sub-menu for `teamclaw config`.
 * Exposes creativity, max_cycles, webhooks, and webhook secret.
 */

import {
  cancel,
  isCancel,
  note,
  password,
  select,
  text,
} from "@clack/prompts";

function handleCancel<T>(v: T): T {
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return v;
}

export interface AdvancedState {
  creativity: number;
  maxCycles: number;
  webhookOnTaskComplete: string;
  webhookOnCycleEnd: string;
  webhookSecret: string;
}

function parseFloat01(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

function parsePositiveInt(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function maskSecret(value: string): string {
  const v = value.trim();
  if (!v) return "(not set)";
  if (v.length <= 8) return "********";
  return `${v.slice(0, 3)}…${v.slice(-4)}`;
}

export async function advancedSettingsMenu(state: AdvancedState): Promise<void> {
  let back = false;
  while (!back) {
    const choice = handleCancel(
      await select({
        message: "Advanced Settings",
        options: [
          {
            value: "creativity",
            label: `Creativity (Current: ${state.creativity.toFixed(1)})`,
          },
          {
            value: "cycles",
            label: `Max Cycles (Current: ${state.maxCycles})`,
          },
          {
            value: "wh_task",
            label: `Webhook: Task Complete (${state.webhookOnTaskComplete || "(not set)"})`,
          },
          {
            value: "wh_cycle",
            label: `Webhook: Cycle End (${state.webhookOnCycleEnd || "(not set)"})`,
          },
          {
            value: "wh_secret",
            label: `Webhook Secret (${maskSecret(state.webhookSecret)})`,
          },
          { value: "back", label: "Back to Main Menu" },
        ],
      }),
    ) as string;

    if (choice === "back") {
      back = true;
      continue;
    }

    if (choice === "creativity") {
      const raw = handleCancel(
        await text({
          message: "Creativity (0.0 - 1.0, maps to LLM temperature)",
          initialValue: String(state.creativity),
          placeholder: "0.5",
          validate: (v) =>
            parseFloat01(v ?? "") !== null
              ? undefined
              : "Must be a number between 0.0 and 1.0",
        }),
      ) as string;
      state.creativity = parseFloat01(raw) ?? state.creativity;
      continue;
    }

    if (choice === "cycles") {
      const raw = handleCancel(
        await text({
          message: "Max Cycles per run",
          initialValue: String(state.maxCycles),
          placeholder: "10",
          validate: (v) =>
            parsePositiveInt(v ?? "") !== null
              ? undefined
              : "Must be a positive integer",
        }),
      ) as string;
      state.maxCycles = parsePositiveInt(raw) ?? state.maxCycles;
      continue;
    }

    if (choice === "wh_task") {
      const raw = handleCancel(
        await text({
          message: "Webhook URL for task completion (leave empty to disable)",
          initialValue: state.webhookOnTaskComplete,
          placeholder: "https://hooks.example.com/task-complete",
        }),
      ) as string;
      state.webhookOnTaskComplete = raw.trim();
      continue;
    }

    if (choice === "wh_cycle") {
      const raw = handleCancel(
        await text({
          message: "Webhook URL for cycle end (leave empty to disable)",
          initialValue: state.webhookOnCycleEnd,
          placeholder: "https://hooks.example.com/cycle-end",
        }),
      ) as string;
      state.webhookOnCycleEnd = raw.trim();
      continue;
    }

    if (choice === "wh_secret") {
      const raw = handleCancel(
        await password({
          message: "Webhook secret (used in X-Webhook-Signature header)",
        }),
      ) as string;
      state.webhookSecret = raw.trim();
      continue;
    }
  }
}
