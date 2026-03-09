#!/usr/bin/env node
/**
 * TeamClaw onboarding wizard — interactive setup for OpenClaw worker and team.
 */

import pc from "picocolors";
import { intro, outro, select, text, password, note, cancel, isCancel, spinner } from "@clack/prompts";
import { logger } from "../core/logger.js";
import { start } from "../daemon/manager.js";
import { writeConfig } from "./writeConfig.js";

export interface RunOnboardOptions {
  installDaemon?: boolean;
}

export async function runOnboard(options?: RunOnboardOptions): Promise<void> {
  const installDaemon = options?.installDaemon ?? false;
  type RosterEntry = { role: string; count: number; description: string };
  type Step =
    | "WORKER_URL"
    | "AUTH_TOKEN"
    | "TEAM_SIZE"
    | "TEAM_BUILDER"
    | "WORKER_ROUTING"
    | "GOAL"
    | "SUMMARY"
    | "FINISH"
    | "EXIT";
  interface WizardState {
    workerUrl: string;
    authToken: string;
    teamSize?: number;
    roster: RosterEntry[];
    workers: Record<string, string>;
    goal: string;
  }
  const DEFAULT_WORKER_URL = process.env["OPENCLAW_WORKER_URL"] ?? "http://localhost:8001";
  const DEFAULT_TOKEN = process.env["OPENCLAW_TOKEN"] ?? "";
  const DEFAULT_GOAL = "Build a small 2D game with sprite assets and sound effects";

  function parseCount(value: string | undefined): number | null {
    const raw = value?.trim() ?? "";
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  }

  function formatRosterSummary(roster: RosterEntry[], totalCapacity: number): string {
    const currentAssigned = roster.reduce((sum, r) => sum + r.count, 0);
    const rolesSummary =
      roster.length === 0
        ? "No roles assigned yet."
        : roster
            .map((r) => `${r.count}x ${r.role}`)
            .join(", ");

    return `Assigned: ${currentAssigned}/${totalCapacity} bots.\nRoster: ${rolesSummary}`;
  }

  function autoScalePreset(
    totalCapacity: number,
    preset: "game-dev" | "startup" | "content",
  ): RosterEntry[] {
    type PresetDef = { role: string; description: string; pct: number };

    let roles: PresetDef[];

    switch (preset) {
      case "game-dev":
        roles = [
          {
            role: "Game Programmer",
            description: "Implements gameplay systems, mechanics, and tools.",
            pct: 0.5,
          },
          {
            role: "Game Designer",
            description: "Designs levels, systems, and core gameplay loops.",
            pct: 0.3,
          },
          {
            role: "Game Artist",
            description: "Creates characters, environments, and visual assets.",
            pct: 0.2,
          },
        ];
        break;
      case "startup":
        roles = [
          {
            role: "Engineer",
            description: "Builds product features and infrastructure.",
            pct: 0.6,
          },
          {
            role: "Product Manager",
            description: "Defines roadmap and prioritizes user needs.",
            pct: 0.2,
          },
          {
            role: "Designer",
            description: "Designs UX/UI and product visuals.",
            pct: 0.2,
          },
        ];
        break;
      case "content":
        roles = [
          {
            role: "Writer",
            description: "Creates long-form content and narratives.",
            pct: 0.5,
          },
          {
            role: "Researcher",
            description: "Finds sources, data, and insights.",
            pct: 0.3,
          },
          {
            role: "Editor",
            description: "Refines, polishes, and maintains consistency.",
            pct: 0.2,
          },
        ];
        break;
    }

    if (totalCapacity <= 0) return [];

    const baseCounts = roles.map((r) => Math.floor(totalCapacity * r.pct));
    let assigned = baseCounts.reduce((sum, n) => sum + n, 0);
    const remainder = totalCapacity - assigned;

    if (remainder > 0) {
      baseCounts[0] += remainder;
      assigned += remainder;
    }

    return roles
      .map((r, idx) => ({
        role: r.role,
        description: r.description,
        count: baseCounts[idx],
      }))
      .filter((r) => r.count > 0);
  }

  function normalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    return `http://${trimmed}`;
  }

  async function validateWorkerUrl(
    baseUrl: string,
  ): Promise<"ok" | { httpStatus: number } | { networkError: string }> {
    const healthUrl = baseUrl.replace(/\/$/, "") + "/health";
    try {
      const res = await fetch(healthUrl);
      if (!res.ok) return { httpStatus: res.status };
      return "ok";
    } catch (e) {
      return { networkError: String((e as Error).message ?? e) };
    }
  }

  function handleCancel<T>(v: T): T {
    if (isCancel(v)) {
      cancel("Setup cancelled.");
      process.exit(0);
    }
    return v;
  }
  function withBackOption<T extends string>(
    options: { label: string; value: T }[],
    canGoBack: boolean,
  ): { label: string; value: T | "__back" }[] {
    return canGoBack
      ? [
          ...options,
          {
            label: pc.dim("← Back"),
            value: "__back" as const,
          },
        ]
      : options;
  }

  intro(pc.bold(pc.cyan("TeamClaw Setup Wizard")));

  const state: WizardState = {
    workerUrl: DEFAULT_WORKER_URL,
    authToken: DEFAULT_TOKEN,
    roster: [],
    workers: {},
    goal: DEFAULT_GOAL,
  };

  const history: Step[] = [];
  let currentStep: Step = "WORKER_URL";

  while (currentStep !== "EXIT" && currentStep !== "FINISH") {
    const canGoBack = history.length > 0;

    switch (currentStep) {
      case "WORKER_URL": {
        const raw = handleCancel(
          await text({
            message: "OpenClaw Gateway URL",
            placeholder: "http://localhost:8001",
            initialValue: state.workerUrl,
            validate: (v) => (((v ?? "").trim().length > 0) ? undefined : "URL cannot be empty"),
          }),
        ) as string;

        const base = normalizeUrl(raw).replace(/\/$/, "");
        const s = spinner();
        s.start("Validating OpenClaw URL (/health)…");
        const check = await validateWorkerUrl(base);
        s.stop();
        if (check !== "ok") {
          const reason = "networkError" in check ? check.networkError : `HTTP ${check.httpStatus}`;
          note(`Cannot validate OpenClaw gateway: ${reason}`, "Validation warning");
        }
        state.workerUrl = base;
        history.push("WORKER_URL");
        currentStep = "AUTH_TOKEN";
        break;
      }

      case "AUTH_TOKEN": {
        note(
          [
            "This is the token your OpenClaw gateway expects in the Authorization header.",
            "Typically it comes from the `auth.token` field in your OpenClaw config and is also exposed as OPENCLAW_TOKEN.",
          ].join("\n"),
          "Where to find the OpenClaw token",
        );
        const token = handleCancel(
          await password({
            message: "OpenClaw Gateway Token (OPENCLAW_TOKEN)",
            validate: (v) => ((v ?? "").trim().length > 0 ? undefined : "Token cannot be empty"),
          }),
        ) as string;
        state.authToken = token.trim();
        history.push("AUTH_TOKEN");
        currentStep = "TEAM_SIZE";
        break;
      }

      case "TEAM_SIZE": {
        const teamSizeRaw = handleCancel(
          await text({
            message: "Total number of bots in your team?",
            initialValue: String(state.teamSize ?? 5),
            placeholder: "5",
            validate: (v) => {
              const n = parseCount(v);
              if (n == null) return "Enter an integer >= 1.";
              if (n > 200) return "Please keep team size <= 200.";
              return undefined;
            },
          }),
        ) as string;
        const teamSize = parseCount(teamSizeRaw) ?? (state.teamSize ?? 5);
        state.teamSize = teamSize;

        if (teamSize > 10) {
          note(
            "Large teams can trigger rate limits or high CPU usage (especially with local gateways).\n" +
              "Consider starting smaller, then scaling up once stable.",
            "Resource warning",
          );
        }

        history.push("TEAM_SIZE");
        currentStep = "TEAM_BUILDER";
        break;
      }

      case "TEAM_BUILDER": {
        const startingPoint = handleCancel(
          await select({
            message: "How do you want to build your team?",
            options: withBackOption(
              [
                { label: "Start from Scratch (Blank Canvas)", value: "scratch" as const },
                { label: "Game Dev Preset", value: "game-dev" as const },
                { label: "Startup Preset", value: "startup" as const },
                { label: "Content Preset", value: "content" as const },
              ],
              canGoBack,
            ),
            initialValue: "scratch",
          }),
        ) as "scratch" | "game-dev" | "startup" | "content" | "__back";

        if (startingPoint === "__back") {
          currentStep = history.pop() ?? "TEAM_SIZE";
          break;
        }

        const total = state.teamSize ?? 5;
        if (startingPoint === "scratch") {
          if (state.roster.length === 0) {
            state.roster = [];
          }
        } else {
          state.roster = autoScalePreset(total, startingPoint);
        }

        // Dynamic modification loop
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const currentAssigned = state.roster.reduce((sum, r) => sum + r.count, 0);
          const remaining = total - currentAssigned;

          note(formatRosterSummary(state.roster, total), "Current roster");

          const action = handleCancel(
            await select({
              message: "What would you like to do?",
              options: [
                { label: "🚀 Confirm and Continue", value: "confirm" },
                { label: "➕ Add a custom role", value: "add" },
                { label: "✏️ Edit a role", value: "edit" },
                { label: "🗑️ Remove a role", value: "remove" },
                ...(canGoBack ? [{ label: pc.dim("← Back"), value: "__back" as const }] : []),
              ],
            }),
          ) as "confirm" | "add" | "edit" | "remove" | "__back";

          if (action === "__back") {
            currentStep = history.pop() ?? "TEAM_SIZE";
            break;
          }

          if (action === "confirm") {
            if (currentAssigned < total) {
              note(
                "Please assign all bots before confirming (some capacity is still unassigned).",
                "Roster incomplete",
              );
              continue;
            }
            if (currentAssigned > total) {
              note(
                "Assigned bots exceed total team size. Please reduce counts.",
                "Roster exceeds capacity",
              );
              continue;
            }
            history.push("TEAM_BUILDER");
            currentStep = "WORKER_ROUTING";
            break;
          }

          if (action === "add") {
            if (remaining <= 0) {
              note(
                "No remaining capacity. Edit or remove existing roles to free up bots.",
                "No capacity remaining",
              );
              continue;
            }

            const roleName = (handleCancel(
              await text({
                message: "Role name?",
                placeholder: "Backend Coder",
                validate: (v) =>
                  ((v ?? "").trim().length > 0 ? undefined : "Role name cannot be empty."),
              }),
            ) as string).trim();

            const description = (handleCancel(
              await text({
                message: "Role description?",
                placeholder: "Focuses on backend services, APIs, and data models.",
              }),
            ) as string).trim();

            const countInput = handleCancel(
              await text({
                message: `How many bots for "${roleName}"? (Remaining capacity: ${remaining})`,
                initialValue: String(Math.min(remaining, 1)),
                validate: (v) => {
                  const n = parseCount(v);
                  if (n == null) return "Please enter a positive integer.";
                  if (n > remaining) {
                    return "Exceeds total team size. Reduce the count or free capacity by editing/removing other roles.";
                  }
                  return undefined;
                },
              }),
            ) as string;

            const count = parseCount(countInput) ?? 1;
            const existingIndex = state.roster.findIndex(
              (r) => r.role.toLowerCase() === roleName.toLowerCase(),
            );

            if (existingIndex >= 0) {
              state.roster[existingIndex] = {
                ...state.roster[existingIndex],
                description: description || state.roster[existingIndex].description,
                count: state.roster[existingIndex].count + count,
              };
            } else {
              state.roster.push({
                role: roleName,
                description: description || "Custom role.",
                count,
              });
            }

            continue;
          }

          if (action === "edit") {
            if (state.roster.length === 0) {
              note("No roles available to edit. Try adding a role first.", "Nothing to edit");
              continue;
            }

            const roleToEdit = handleCancel(
              await select({
                message: "Which role would you like to edit?",
                options: state.roster.map((r, idx) => ({
                  value: idx,
                  label: `${r.role} (${r.count} bots)`,
                })),
              }),
            ) as number;

            const existing = state.roster[roleToEdit];

            const newName = (handleCancel(
              await text({
                message: `Edit role name (currently "${existing.role}")`,
                initialValue: existing.role,
                validate: (v) =>
                  ((v ?? "").trim().length > 0 ? undefined : "Role name cannot be empty."),
              }),
            ) as string).trim();

            const newDescription = (handleCancel(
              await text({
                message: "Edit role description",
                initialValue: existing.description,
              }),
            ) as string).trim();

            const newCountInput = handleCancel(
              await text({
                message: `Edit bot count for "${newName}"`,
                initialValue: String(existing.count),
                validate: (v) => {
                  const n = parseCount(v);
                  if (n == null) return "Please enter a positive integer.";
                  const hypotheticalTotal = currentAssigned - existing.count + n;
                  if (hypotheticalTotal > total) {
                    return "Exceeds total team size. Reduce the count or free capacity by editing/removing other roles.";
                  }
                  return undefined;
                },
              }),
            ) as string;

            const newCount = parseCount(newCountInput) ?? existing.count;
            state.roster[roleToEdit] = {
              role: newName,
              description: newDescription || existing.description,
              count: newCount,
            };

            continue;
          }

          if (action === "remove") {
            if (state.roster.length === 0) {
              note("No roles available to remove.", "Nothing to remove");
              continue;
            }

            const roleToRemove = handleCancel(
              await select({
                message: "Which role would you like to remove?",
                options: state.roster.map((r, idx) => ({
                  value: idx,
                  label: `${r.role} (${r.count} bots)`,
                })),
              }),
            ) as number;

            state.roster.splice(roleToRemove, 1);
            continue;
          }
        }

        break;
      }

      case "WORKER_ROUTING": {
        const mode = handleCancel(
          await select({
            message: "Gateway routing mode for workers",
            options: withBackOption(
              [
                {
                  label: "Shared gateway (sequential per gateway URL)",
                  value: "shared" as const,
                },
                {
                  label: "Dedicated gateways (parallel across different URLs)",
                  value: "dedicated" as const,
                },
              ],
              canGoBack,
            ),
          }),
        ) as "shared" | "dedicated" | "__back";

        if (mode === "__back") {
          currentStep = history.pop() ?? "TEAM_BUILDER";
          break;
        }

        if (mode === "shared") {
          state.workers = {};
          history.push("WORKER_ROUTING");
          currentStep = "GOAL";
          break;
        }

        const customWorkers: Record<string, string> = {};
        for (const role of state.roster) {
          const key = role.role.trim();
          const existing = state.workers[key] ?? state.workerUrl;
          const rawUrl = handleCancel(
            await text({
              message: `Dedicated gateway URL for "${key}" (${role.count} bot${role.count > 1 ? "s" : ""})`,
              initialValue: existing,
              placeholder: "http://localhost:8002",
              validate: (v) => {
                const value = (v ?? "").trim();
                if (!value) return "Gateway URL cannot be empty in dedicated mode.";
                return undefined;
              },
            }),
          ) as string;
          customWorkers[key] = normalizeUrl(rawUrl).replace(/\/$/, "");
        }
        state.workers = customWorkers;
        history.push("WORKER_ROUTING");
        currentStep = "GOAL";
        break;
      }

      case "GOAL": {
        const goalRaw = handleCancel(
          await text({
            message: "Default goal for first run (optional)",
            placeholder: state.goal,
            initialValue: state.goal,
          }),
        ) as string;
        state.goal = goalRaw.trim() || state.goal;

        const nav = handleCancel(
          await select({
            message: `Goal preview:\n${state.goal}\n`,
            options: withBackOption(
              [
                { label: "✅ Proceed", value: "proceed" as const },
                { label: "✏️ Edit goal again", value: "edit" as const },
              ],
              canGoBack,
            ),
          }),
        ) as "proceed" | "edit" | "__back";

        if (nav === "__back") {
          currentStep = history.pop() ?? "WORKER_URL";
          break;
        }
        if (nav === "edit") {
          break;
        }

        history.push("GOAL");
        currentStep = "SUMMARY";
        break;
      }

      case "SUMMARY": {
        const teamSize =
          state.teamSize ?? state.roster.reduce((sum, r) => sum + r.count, 0) ?? 0;

        note(
          [
            `Worker URL: ${state.workerUrl}`,
            `Auth Token: ${state.authToken ? "Configured" : "(missing)"}`,
            `Goal: ${state.goal}`,
            `Team size: ${teamSize}`,
            `Routing: ${
              Object.keys(state.workers).length > 0
                ? `Dedicated (${Object.keys(state.workers).length} role mapping${Object.keys(state.workers).length > 1 ? "s" : ""})`
                : "Shared (single gateway URL)"
            }`,
            `Roster: ${
              state.roster.length
                ? state.roster.map((r) => `${r.count}x ${r.role}`).join(", ")
                : "(none)"
            }`,
          ].join("\n"),
          "Configuration summary",
        );

        const choice = handleCancel(
          await select({
            message: "Save this configuration?",
            options: withBackOption(
              [
                { label: "✅ Save and finish", value: "finish" as const },
                { label: "✏️ Go back and edit", value: "back" as const },
              ],
              canGoBack,
            ),
          }),
        ) as "finish" | "back" | "__back";

        if (choice === "back" || choice === "__back") {
          currentStep = history.pop() ?? "GOAL";
          break;
        }

        writeConfig({
          workerUrl: state.workerUrl,
          authToken: state.authToken,
          roster: state.roster,
          workers: state.workers,
          goal: state.goal,
        });

        if (installDaemon) {
          const result = start({
            web: true,
            gateway: false,
          });
          if (result.error) {
            note(result.error, "Daemon install failed");
          } else {
            note("Web (and Gateway if configured) started in background.", "Daemon status");
          }
        }

        currentStep = "FINISH";
        break;
      }

      default: {
        currentStep = "EXIT";
        break;
      }
    }
  }

  if (currentStep === "FINISH") {
    note(
      [
        `${pc.cyan("teamclaw work")}     Start a session`,
        `${pc.cyan("teamclaw web")}      Open the dashboard`,
        `${pc.cyan("teamclaw status")}   Check background services`,
      ].join("\n"),
      "Next steps",
    );

    outro(pc.green("✅ Setup complete!"));
  }
}

const isMain = process.argv[1]?.endsWith("onboard.js") ?? false;
if (isMain) {
  runOnboard().catch((err) => {
    logger.error(String(err));
    process.exit(1);
  });
}
