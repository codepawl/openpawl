/**
 * TeamClaw project config (teamclaw.config.json).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { TEAM_TEMPLATES } from "./team-templates.js";
import { getRoleTemplate } from "./bot-definitions.js";

export interface TeamConfig {
  template?: string;
  roster?: Array<{ role: string; count: number; description: string }>;
  workers?: Record<string, string>;
  worker_url?: string;
  gateway_url?: string;
  team_model?: string;
  bots?: Array<{ id: string; role_id: string; name?: string; worker_url?: string }>;
  goal?: string;
  creativity?: number;
  memory_backend?: "lancedb" | "local_json";
  openclaw_chat_endpoint?: string;
  openclaw_model?: string;
  openclaw_token?: string;
  webhooks?: {
    on_task_complete?: string;
    on_cycle_end?: string;
  };
}

let _cached: TeamConfig | null | undefined;

export async function loadTeamConfig(): Promise<TeamConfig | null> {
  if (_cached !== undefined) return _cached;
  try {
    const raw = await readFile(path.join(process.cwd(), "teamclaw.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const creativity =
      typeof parsed.creativity === "number"
        ? Math.max(0, Math.min(1, parsed.creativity))
        : undefined;

    const parsedRosterRaw = parsed.roster;
    const parsedRoster =
      Array.isArray(parsedRosterRaw)
        ? parsedRosterRaw
            .map((x) => {
              if (!x || typeof x !== "object" || Array.isArray(x)) return null;
              const o = x as Record<string, unknown>;
              const role = typeof o.role === "string" ? o.role.trim() : "";
              const count = typeof o.count === "number" ? o.count : Number(o.count);
              const description =
                typeof o.description === "string" ? o.description.trim() : "";
              if (!role) return null;
              if (!Number.isFinite(count) || count < 1) return null;
              return { role, count: Math.floor(count), description };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null)
        : undefined;

    const template = typeof parsed.template === "string" ? parsed.template : undefined;
    const roster: TeamConfig["roster"] =
      parsedRoster && parsedRoster.length > 0
        ? parsedRoster
        : template
          ? (() => {
              const t = TEAM_TEMPLATES[template];
              if (!t) return undefined;
              return t.slots.map((s) => {
                const rt = getRoleTemplate(s.role_id);
                const role = rt?.name ?? s.role_id;
                const focus = rt?.default_traits?.["focus"];
                const description =
                  typeof focus === "string" && focus.trim()
                    ? focus.trim()
                    : rt?.task_types?.length
                      ? `Tasks: ${rt.task_types.join(", ")}`
                      : "";
                return { role, count: s.count, description };
              });
            })()
          : undefined;

    _cached = {
      template,
      roster,
      worker_url: typeof parsed.worker_url === "string" ? parsed.worker_url : undefined,
      gateway_url: typeof parsed.gateway_url === "string" ? parsed.gateway_url : undefined,
      team_model: typeof parsed.team_model === "string" ? parsed.team_model : undefined,
      workers:
        parsed.workers && typeof parsed.workers === "object" && !Array.isArray(parsed.workers)
          ? Object.fromEntries(
              Object.entries(parsed.workers as Record<string, unknown>)
                .map(([k, v]) => [k.trim(), typeof v === "string" ? v.trim() : ""])
                .filter(([k, v]) => k.length > 0 && v.length > 0),
            )
          : undefined,
      bots: Array.isArray(parsed.bots) ? (parsed.bots as TeamConfig["bots"]) : undefined,
      goal: typeof parsed.goal === "string" ? parsed.goal : undefined,
      creativity,
      openclaw_chat_endpoint:
        typeof parsed.openclaw_chat_endpoint === "string"
          ? parsed.openclaw_chat_endpoint.trim()
          : undefined,
      openclaw_model:
        typeof parsed.openclaw_model === "string"
          ? parsed.openclaw_model.trim()
          : undefined,
      memory_backend:
        parsed.memory_backend === "lancedb" || parsed.memory_backend === "local_json"
          ? parsed.memory_backend
          : parsed.memory_backend === "chroma"
            ? "lancedb"
            : undefined,
    };
  } catch {
    _cached = null;
  }
  return _cached;
}

export function clearTeamConfigCache(): void {
  _cached = undefined;
}
