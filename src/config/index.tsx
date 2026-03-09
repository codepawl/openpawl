import {
  cancel,
  intro,
  isCancel,
  note,
  outro,
  select,
  text,
  password,
} from "@clack/prompts";
import pc from "picocolors";
import { setConfigValue } from "../core/configManager.js";

export async function runConfigEditor(): Promise<void> {
  function handleCancel<T>(v: T): T {
    if (isCancel(v)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    return v;
  }

  const parseCreativity = (s: string | undefined): number | null => {
    const raw = s?.trim() ?? "";
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0 || n > 1) return null;
    return n;
  };

  const parseMaxCycles = (s: string | undefined): number | null => {
    const raw = s?.trim() ?? "";
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  };

  intro(pc.bold(pc.cyan("TeamClaw Config")));

  const section = handleCancel(
    await select({
      message: "What do you want to edit?",
      options: [
        { label: "OpenClaw Connection", value: "openclaw" },
        { label: "AI Tuning", value: "ai" },
        { label: "Exit", value: "exit" },
      ],
      initialValue: "openclaw",
    }),
  ) as "openclaw" | "ai" | "exit";

  if (section === "exit") {
    outro("Bye.");
    return;
  }

  if (section === "openclaw") {
    const workerUrl = handleCancel(
      await text({
        message: "OpenClaw Gateway URL",
        initialValue: "http://localhost:8001",
        placeholder: "http://localhost:8001",
        validate: (v) => ((v ?? "").trim().length > 0 ? undefined : "URL cannot be empty"),
      }),
    ) as string;
    const token = handleCancel(
      await password({
        message: "OpenClaw token",
        validate: (v) => ((v ?? "").trim().length > 0 ? undefined : "Token cannot be empty"),
      }),
    ) as string;

    setConfigValue("OPENCLAW_WORKER_URL", workerUrl.trim());
    setConfigValue("OPENCLAW_TOKEN", token.trim());

    note(`Saved:\n- OPENCLAW_WORKER_URL=${workerUrl.trim()}\n- OPENCLAW_TOKEN=***`, "OpenClaw Connection");
    outro(pc.green("Done."));
    return;
  }

  if (section === "ai") {
    const creativityRaw = handleCancel(
      await text({
        message: "Creativity (0.0–1.0)",
        initialValue: "0.7",
        placeholder: "0.7",
        validate: (v) => (parseCreativity(v) != null ? undefined : "Creativity must be between 0.0 and 1.0."),
      }),
    ) as string;
    const maxCyclesRaw = handleCancel(
      await text({
        message: "Max agent cycles (integer ≥ 1)",
        initialValue: "5",
        placeholder: "5",
        validate: (v) => (parseMaxCycles(v) != null ? undefined : "Max agent cycles must be an integer >= 1."),
      }),
    ) as string;

    const creativity = parseCreativity(creativityRaw) ?? 0.7;
    const maxCycles = parseMaxCycles(maxCyclesRaw) ?? 5;

    const r1 = setConfigValue("creativity", String(creativity));
    const r2 = setConfigValue("max_cycles", String(maxCycles));
    if ("error" in r1) {
      note(r1.error, "Save failed");
      outro("Failed.");
      process.exitCode = 1;
      return;
    }
    if ("error" in r2) {
      note(r2.error, "Save failed");
      outro("Failed.");
      process.exitCode = 1;
      return;
    }
    note(`Saved:\n- creativity=${creativity}\n- max_cycles=${maxCycles}`, "AI Tuning");
    outro(pc.green("Done."));
    return;
  }

  outro(pc.green("Done."));
}

