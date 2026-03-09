import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import { discoverOpenAIApi } from "../core/discovery.js";
import { getEnvValue, readEnvFile, setEnvValue, writeEnvFile } from "../core/envManager.js";
import { readTeamclawConfig, writeTeamclawConfig } from "../core/jsonConfigManager.js";
import { clearTeamConfigCache, loadTeamConfig } from "../core/team-config.js";

type MemoryBackend = "lancedb" | "local_json";
type LoggingLevel = "info" | "verbose";
type RosterEntry = { role: string; count: number; description: string };

interface DashboardState {
  openclawWorkerUrl: string;
  openclawToken: string;
  openclawModel: string;
  openclawChatEndpoint: string;
  memoryBackend: MemoryBackend;
  memoryPath: string;
  roster: RosterEntry[];
  workers: Record<string, string>;
  webPort: number;
  loggingLevel: LoggingLevel;
}

function maskSecret(value: string): string {
  const v = value.trim();
  if (!v) return "(not set)";
  if (v.length <= 8) return "********";
  return `${v.slice(0, 3)}…${v.slice(-4)}`;
}

function isHttpOrWsUrl(value: string): boolean {
  return /^(https?|wss?):\/\//i.test(value.trim());
}

function parsePort(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function parsePortFromUrl(value: string): number | undefined {
  const input = value.trim();
  if (!input) return undefined;
  try {
    const withProtocol = input.includes("://") ? input : `http://${input}`;
    const parsed = new URL(withProtocol);
    if (!parsed.port) return undefined;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function fetchModelsForService(baseUrl: string, token: string): Promise<string[]> {
  const httpBase = /^wss?:\/\//i.test(baseUrl)
    ? baseUrl.replace(/^wss?:\/\//i, "http://")
    : baseUrl;
  const modelsUrl = `${httpBase.replace(/\/$/, "")}/v1/models`;
  try {
    const headers: Record<string, string> = {};
    if (token.trim().length > 0) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const fromData =
      data.data
        ?.map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
        .filter((x) => x.length > 0) ?? [];
    const fromModels =
      data.models
        ?.map((m) => {
          const id = typeof m.id === "string" ? m.id.trim() : "";
          const name = typeof m.name === "string" ? m.name.trim() : "";
          return id || name;
        })
        .filter((x) => x.length > 0) ?? [];
    return Array.from(new Set([...fromData, ...fromModels]));
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function handleCancel<T>(v: T): T {
  if (isCancel(v)) {
    cancel("Configuration editor cancelled.");
    process.exit(0);
  }
  return v;
}

async function loadDashboardState(): Promise<DashboardState> {
  const env = readEnvFile();
  const cfg = readTeamclawConfig();
  const parsed = await loadTeamConfig();
  const data = asRecord(cfg.data);

  const envBool = (key: string, fallback: boolean): boolean => {
    const raw = (getEnvValue(key, env.lines) ?? "").trim();
    if (!raw) return fallback;
    return ["1", "true", "yes"].includes(raw.toLowerCase());
  };

  const envStr = (key: string): string => (getEnvValue(key, env.lines) ?? "").trim();

  const memoryBackendRaw =
    envStr("MEMORY_BACKEND") ||
    (typeof data.memory_backend === "string" ? data.memory_backend : "") ||
    (parsed?.memory_backend ?? "");
  const memoryBackend: MemoryBackend =
    memoryBackendRaw === "local_json" ? "local_json" : "lancedb";

  const webPort = parsePort(envStr("WEB_PORT")) ?? 8000;
  const loggingLevel: LoggingLevel = envBool("VERBOSE_LOGGING", true) ? "verbose" : "info";

  const openclawWorkerUrl =
    envStr("OPENCLAW_WORKER_URL") ||
    (typeof data.worker_url === "string" ? data.worker_url.trim() : "") ||
    (parsed?.worker_url?.trim() ?? "");

  const openclawChatEndpoint =
    envStr("OPENCLAW_CHAT_ENDPOINT") ||
    (typeof data.openclaw_chat_endpoint === "string"
      ? data.openclaw_chat_endpoint.trim()
      : "") ||
    (parsed?.openclaw_chat_endpoint?.trim() ?? "/v1/chat/completions");

  const openclawModel =
    envStr("OPENCLAW_MODEL") ||
    (typeof data.openclaw_model === "string" ? data.openclaw_model.trim() : "") ||
    (parsed?.openclaw_model?.trim() ?? "");

  const token = envStr("OPENCLAW_TOKEN") || envStr("OPENCLAW_AUTH_TOKEN");

  const workers = parsed?.workers ?? {};
  const roster = parsed?.roster ?? [];

  return {
    openclawWorkerUrl,
    openclawToken: token,
    openclawModel,
    openclawChatEndpoint,
    memoryBackend,
    memoryPath: envStr("CHROMADB_PERSIST_DIR") || "data/vector_store",
    roster,
    workers,
    webPort,
    loggingLevel,
  };
}

async function openClawMenu(state: DashboardState): Promise<void> {
  let back = false;
  while (!back) {
    const choice = handleCancel(
      await select({
        message: "OpenClaw & LLM Settings",
        options: [
          {
            value: "url",
            label: `Edit OpenClaw Gateway URL (Current: ${state.openclawWorkerUrl || "(not set)"})`,
          },
          {
            value: "model",
            label: `Edit Default Model (Current: ${state.openclawModel || "(not set)"})`,
          },
          {
            value: "token",
            label: `Edit API Token (Current: ${maskSecret(state.openclawToken)})`,
          },
          {
            value: "endpoint",
            label: `Edit Chat Endpoint (Current: ${state.openclawChatEndpoint || "(not set)"})`,
          },
          { value: "discover", label: "Run Auto-Discovery Scanner" },
          { value: "back", label: "Back to Main Menu" },
        ],
      }),
    ) as "url" | "model" | "token" | "endpoint" | "discover" | "back";

    if (choice === "back") {
      back = true;
      continue;
    }

    if (choice === "url") {
      const value = handleCancel(
        await text({
          message: "OpenClaw Gateway URL",
          initialValue: state.openclawWorkerUrl || "http://localhost:8001",
          placeholder: "http://localhost:8001",
          validate: (v) =>
            isHttpOrWsUrl(v ?? "") ? undefined : "URL must start with http://, https://, ws://, or wss://",
        }),
      ) as string;
      state.openclawWorkerUrl = value.trim();
      continue;
    }

    if (choice === "model") {
      const value = handleCancel(
        await text({
          message: "Default OpenClaw Model",
          initialValue: state.openclawModel,
          placeholder: "gpt-4o-mini",
          validate: (v) => ((v ?? "").trim().length > 0 ? undefined : "Model cannot be empty"),
        }),
      ) as string;
      state.openclawModel = value.trim();
      continue;
    }

    if (choice === "token") {
      const value = handleCancel(
        await password({
          message: "OpenClaw API Token",
          validate: (v) => ((v ?? "").trim().length > 0 ? undefined : "Token cannot be empty"),
        }),
      ) as string;
      state.openclawToken = value.trim();
      continue;
    }

    if (choice === "endpoint") {
      const value = handleCancel(
        await text({
          message: "OpenClaw Chat Endpoint",
          initialValue: state.openclawChatEndpoint || "/v1/chat/completions",
          placeholder: "/v1/chat/completions",
          validate: (v) =>
            (v ?? "").trim().startsWith("/") ? undefined : "Endpoint must start with '/'",
        }),
      ) as string;
      state.openclawChatEndpoint = value.trim();
      continue;
    }

    if (choice === "discover") {
      const s = spinner();
      s.start("Scanning local network for OpenClaw API...");
      const discovered = await discoverOpenAIApi("http://localhost", {
        preferredPort: parsePortFromUrl(state.openclawWorkerUrl),
        timeoutMs: 1000,
      }).catch(() => []);
      if (discovered.length === 0) {
        s.stop("Could not auto-detect API.");
        note(
          "Ensure you are pointing to the API port, not the Web UI port (8001 is often UI).",
          "Discovery warning",
        );
        continue;
      }
      let selectedService = discovered[0]!;
      s.stop(`Found ${discovered.length} OpenAI-compatible service(s).`);
      const pickedService = handleCancel(
        await select({
          message: discovered.length > 1 ? "Select detected service:" : "Detected service:",
          options: discovered.map((d, idx) => {
            const proto = d.protocol === "ws" ? pc.magenta("[WS]") : pc.cyan("[HTTP]");
            const modelSummary =
              d.protocol === "ws"
                ? "model list requires token"
                : `${d.models.length} models found`;
            return {
              value: String(idx),
              label: `${proto} Port ${d.port} (${d.serviceName} - ${modelSummary})`,
            };
          }),
          initialValue: "0",
        }),
      ) as string;
      const pickedIdx = Number(pickedService);
      if (
        Number.isInteger(pickedIdx) &&
        pickedIdx >= 0 &&
        pickedIdx < discovered.length
      ) {
        selectedService = discovered[pickedIdx]!;
      }

      state.openclawWorkerUrl = selectedService.baseUrl;
      state.openclawChatEndpoint = selectedService.chatEndpoint;

      if (selectedService.protocol === "ws") {
        const tokenValue = handleCancel(
          await password({
            message: "Selected WebSocket gateway. Enter OPENCLAW_TOKEN:",
            validate: (v) =>
              ((v ?? "").trim().length > 0 ? undefined : "Token cannot be empty"),
          }),
        ) as string;
        state.openclawToken = tokenValue.trim();
        const models = await fetchModelsForService(
          selectedService.baseUrl,
          state.openclawToken,
        );
        if (models.length > 0) {
          const selectedModel = handleCancel(
            await select({
              message: "Select model for selected WebSocket service:",
              options: models.map((m) => ({ value: m, label: m })),
              initialValue: models[0],
            }),
          ) as string;
          state.openclawModel = selectedModel.trim();
        } else {
          const modelValue = handleCancel(
            await text({
              message:
                "Could not auto-fetch models for this WS gateway. Enter OPENCLAW_MODEL manually:",
              initialValue: state.openclawModel || "",
              placeholder: "qwen2.5-coder:7b",
              validate: (v) =>
                ((v ?? "").trim().length > 0 ? undefined : "Model cannot be empty"),
            }),
          ) as string;
          state.openclawModel = modelValue.trim();
          note(
            "Model list not returned by gateway on /v1/models. Saved manual model value.",
            "WebSocket service selected",
          );
        }
      } else if (selectedService.models.length > 0) {
        const selectedModel = handleCancel(
          await select({
            message: "Select model for selected HTTP service:",
            options: selectedService.models.map((m) => ({ value: m, label: m })),
            initialValue: selectedService.models[0],
          }),
        ) as string;
        state.openclawModel = selectedModel.trim();
      }
    }
  }
}

async function memoryMenu(state: DashboardState): Promise<void> {
  let back = false;
  while (!back) {
    const choice = handleCancel(
      await select({
        message: "Memory & Database",
        options: [
          {
            value: "backend",
            label: `Edit Memory Backend (Current: ${state.memoryBackend})`,
          },
          {
            value: "path",
            label: `Edit Memory Path (Current: ${state.memoryPath})`,
          },
          { value: "back", label: "Back to Main Menu" },
        ],
      }),
    ) as "backend" | "path" | "back";

    if (choice === "back") {
      back = true;
      continue;
    }
    if (choice === "backend") {
      const selected = handleCancel(
        await select({
          message: "Select memory backend",
          initialValue: state.memoryBackend,
          options: [
            { value: "lancedb", label: "LanceDB" },
            { value: "local_json", label: "Local JSON" },
          ],
        }),
      ) as MemoryBackend;
      state.memoryBackend = selected;
      continue;
    }
    if (choice === "path") {
      const value = handleCancel(
        await text({
          message: "Memory database path",
          initialValue: state.memoryPath,
          placeholder: "data/vector_store",
          validate: (v) => ((v ?? "").trim().length > 0 ? undefined : "Path cannot be empty"),
        }),
      ) as string;
      state.memoryPath = value.trim();
    }
  }
}

function rosterSummary(state: DashboardState): string {
  if (state.roster.length === 0) return "(No roles configured)";
  return state.roster
    .map((r) => `${r.count}x ${r.role}${r.description ? ` — ${r.description}` : ""}`)
    .join("\n");
}

async function teamMenu(state: DashboardState): Promise<void> {
  let back = false;
  while (!back) {
    const choice = handleCancel(
      await select({
        message: "Team Roster & Workers",
        options: [
          { value: "view", label: "View current roles" },
          { value: "onboard", label: "Launch Roster Builder (Onboarding Wizard)" },
          { value: "back", label: "Back to Main Menu" },
        ],
      }),
    ) as "view" | "onboard" | "back";

    if (choice === "back") {
      back = true;
      continue;
    }
    if (choice === "view") {
      note(rosterSummary(state), "Current roster");
      continue;
    }
    const run = handleCancel(
      await confirm({
        message: "Open onboarding roster builder now?",
        initialValue: true,
      }),
    ) as boolean;
    if (!run) continue;
    const { runOnboard } = await import("../onboard/index.js");
    await runOnboard();
    const refreshed = await loadDashboardState();
    state.roster = refreshed.roster;
    state.workers = refreshed.workers;
    state.openclawWorkerUrl = refreshed.openclawWorkerUrl || state.openclawWorkerUrl;
    state.openclawToken = refreshed.openclawToken || state.openclawToken;
    state.openclawModel = refreshed.openclawModel || state.openclawModel;
    state.openclawChatEndpoint = refreshed.openclawChatEndpoint || state.openclawChatEndpoint;
    note("Reloaded configuration from onboarding.", "Roster builder completed");
  }
}

async function systemMenu(state: DashboardState): Promise<void> {
  let back = false;
  while (!back) {
    const choice = handleCancel(
      await select({
        message: "System Preferences",
        options: [
          {
            value: "port",
            label: `Edit Default Web UI Port (Current: ${state.webPort})`,
          },
          {
            value: "logging",
            label: `Edit Logging Level (Current: ${state.loggingLevel})`,
          },
          { value: "back", label: "Back to Main Menu" },
        ],
      }),
    ) as "port" | "logging" | "back";

    if (choice === "back") {
      back = true;
      continue;
    }
    if (choice === "port") {
      const raw = handleCancel(
        await text({
          message: "Default Web UI Port",
          initialValue: String(state.webPort),
          placeholder: "8000",
          validate: (v) => (parsePort(v ?? "") != null ? undefined : "Port must be an integer 1-65535"),
        }),
      ) as string;
      state.webPort = parsePort(raw.trim()) ?? state.webPort;
      continue;
    }
    const selected = handleCancel(
      await select({
        message: "Logging level",
        initialValue: state.loggingLevel,
        options: [
          { value: "info", label: "Info" },
          { value: "verbose", label: "Verbose" },
        ],
      }),
    ) as LoggingLevel;
    state.loggingLevel = selected;
  }
}

function applyRuntime(state: DashboardState): void {
  process.env["OPENCLAW_WORKER_URL"] = state.openclawWorkerUrl;
  process.env["OPENCLAW_TOKEN"] = state.openclawToken;
  process.env["OPENCLAW_CHAT_ENDPOINT"] = state.openclawChatEndpoint;
  process.env["OPENCLAW_MODEL"] = state.openclawModel;
  process.env["MEMORY_BACKEND"] = state.memoryBackend;
  process.env["CHROMADB_PERSIST_DIR"] = state.memoryPath;
  process.env["WEB_PORT"] = String(state.webPort);
  process.env["VERBOSE_LOGGING"] = state.loggingLevel === "verbose" ? "true" : "false";
}

function saveState(state: DashboardState): void {
  const env = readEnvFile();
  let lines = env.lines;
  lines = setEnvValue("OPENCLAW_WORKER_URL", state.openclawWorkerUrl, lines);
  lines = setEnvValue("OPENCLAW_TOKEN", state.openclawToken, lines);
  lines = setEnvValue("OPENCLAW_CHAT_ENDPOINT", state.openclawChatEndpoint, lines);
  lines = setEnvValue("OPENCLAW_MODEL", state.openclawModel, lines);
  lines = setEnvValue("MEMORY_BACKEND", state.memoryBackend, lines);
  lines = setEnvValue("CHROMADB_PERSIST_DIR", state.memoryPath, lines);
  lines = setEnvValue("WEB_PORT", String(state.webPort), lines);
  lines = setEnvValue("VERBOSE_LOGGING", state.loggingLevel === "verbose" ? "true" : "false", lines);
  writeEnvFile(env.path, lines);

  const cfg = readTeamclawConfig();
  const next = {
    ...cfg.data,
    worker_url: state.openclawWorkerUrl,
    openclaw_chat_endpoint: state.openclawChatEndpoint,
    openclaw_model: state.openclawModel,
    memory_backend: state.memoryBackend,
    roster: state.roster,
    workers: state.workers,
  } as Record<string, unknown>;
  writeTeamclawConfig(cfg.path, next);
  clearTeamConfigCache();
  applyRuntime(state);
}

export async function runConfigDashboard(): Promise<void> {
  intro(pc.bold(pc.cyan("TeamClaw Configuration Dashboard")));
  const state = await loadDashboardState();

  let keepRunning = true;
  while (keepRunning) {
    const choice = handleCancel(
      await select({
        message: "Main Menu",
        options: [
          { value: "openclaw", label: "🔌 OpenClaw & LLM Settings" },
          { value: "memory", label: "🧠 Memory & Database" },
          { value: "team", label: "🤖 Team Roster & Workers" },
          { value: "system", label: "⚙️ System Preferences" },
          { value: "save", label: "💾 Save & Exit" },
        ],
      }),
    ) as "openclaw" | "memory" | "team" | "system" | "save";

    if (choice === "openclaw") {
      await openClawMenu(state);
      continue;
    }
    if (choice === "memory") {
      await memoryMenu(state);
      continue;
    }
    if (choice === "team") {
      await teamMenu(state);
      continue;
    }
    if (choice === "system") {
      await systemMenu(state);
      continue;
    }

    const doSave = handleCancel(
      await confirm({
        message: "Save changes and exit?",
        initialValue: true,
      }),
    ) as boolean;
    if (!doSave) continue;
    saveState(state);
    note("Configuration saved successfully!", "Success");
    keepRunning = false;
  }

  outro("Configuration dashboard closed.");
  process.exit(0);
}

