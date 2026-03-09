import { useEffect, useState } from "react";
import { useWsStore } from "../ws";

function getApiBase(): string {
  if (typeof location === "undefined") return "";
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env && typeof env === "string") {
    const base = env.replace(/^ws:/, "http:").replace(/\/ws\/?$/, "");
    if (base) return base;
  }
  return location.origin;
}

export function SettingsPanel() {
  const config = useWsStore((s) => s.config);
  const setConfig = useWsStore((s) => s.setConfig);
  const setLastError = useWsStore((s) => s.setLastError);
  const sendMessage = useWsStore((s) => s.sendMessage);

  const [template, setTemplate] = useState(
    (config?.saved_template as string) ?? "game_dev"
  );
  const [goal, setGoal] = useState((config?.saved_goal as string) ?? "");
  const [workerUrl, setWorkerUrl] = useState(
    (config?.saved_worker_url as string) ?? ""
  );
  const [creativity, setCreativity] = useState(
    Number(config?.creativity ?? 0.5)
  );
  const [maxCycles, setMaxCycles] = useState(
    Number(config?.max_cycles ?? 10)
  );
  const [maxGenerations, setMaxGenerations] = useState(
    Number(config?.max_generations ?? 5)
  );
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "ok" | "error">(
    "idle"
  );
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    if (config) {
      setTemplate((config.saved_template as string) ?? "game_dev");
      setGoal((config.saved_goal as string) ?? "");
      setWorkerUrl((config.saved_worker_url as string) ?? "");
      const c = Number(config.creativity);
      const mc = Number(config.max_cycles);
      const mg = Number(config.max_generations);
      if (Number.isFinite(c)) setCreativity(c);
      if (Number.isFinite(mc)) setMaxCycles(mc);
      if (Number.isFinite(mg)) setMaxGenerations(mg);
    }
  }, [config]);

  useEffect(() => {
    if (config) return;
    const base = getApiBase();
    if (!base) return;
    fetch(`${base}/api/config`)
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setTemplate((data.saved_template as string) ?? "game_dev");
        setGoal((data.saved_goal as string) ?? "");
        setWorkerUrl((data.saved_worker_url as string) ?? "");
        const c = Number(data.creativity);
        const mc = Number(data.max_cycles);
        const mg = Number(data.max_generations);
        if (Number.isFinite(c)) setCreativity(c);
        if (Number.isFinite(mc)) setMaxCycles(mc);
        if (Number.isFinite(mg)) setMaxGenerations(mg);
      })
      .catch(() => {});
  }, [config, setConfig]);

  async function handleSave() {
    setSaveStatus("saving");
    setLastError(null);

    const base = getApiBase();

    try {
      const res = await fetch(`${base}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template,
          goal: goal.trim(),
          worker_url: workerUrl.trim(),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setSaveStatus("error");
        setSaveMessage(data.error ?? `HTTP ${res.status}`);
        setLastError(data.error ?? "Failed to save config");
        return;
      }

      sendMessage({
        command: "config",
        values: {
          creativity: Math.max(0, Math.min(1, creativity)),
          max_cycles: Math.max(1, Math.floor(maxCycles)),
          max_generations: Math.max(1, Math.floor(maxGenerations)),
        },
      });

      setSaveStatus("ok");
      setSaveMessage("Config saved. Runtime values applied.");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      setSaveStatus("error");
      setSaveMessage(String(err));
      setLastError(String(err));
    }
  }

  return (
    <section className="max-w-xl rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-4 shadow-sm transition-colors duration-200 ease-in-out">
      <h2 className="mb-4 text-lg font-semibold text-gray-700 dark:text-gray-200">Settings</h2>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="settings-template"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Team Template
          </label>
          <select
            id="settings-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          >
            <option value="game_dev">
              Game Dev (Programmers, Artist, SFX, Designer)
            </option>
            <option value="startup">Startup (Engineers, PM, Designer)</option>
            <option value="content">Content (Writer, Editor, Designer)</option>
          </select>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            Changes to Template and Goal will take effect on the next session
            start.
          </p>
        </div>

        <div>
          <label
            htmlFor="settings-goal"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Goal
          </label>
          <textarea
            id="settings-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            placeholder="e.g. Build a simple 2D platformer with sprite assets and sound effects"
            className="w-full rounded border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          />
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            Changes to Template and Goal will take effect on the next session
            start.
          </p>
        </div>

        <div>
          <label
            htmlFor="settings-worker"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            OpenClaw Worker URL
          </label>
          <input
            id="settings-worker"
            type="text"
            value={workerUrl}
            onChange={(e) => setWorkerUrl(e.target.value)}
            placeholder="http://localhost:8001"
            className="w-full rounded border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          />
        </div>

        <div>
          <label
            htmlFor="settings-creativity"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Creativity (0–1)
          </label>
          <input
            id="settings-creativity"
            type="number"
            min={0}
            max={1}
            step={0.1}
            value={creativity}
            onChange={(e) => setCreativity(Number(e.target.value) || 0)}
            className="w-full rounded border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          />
        </div>

        <div>
          <label
            htmlFor="settings-max-cycles"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Max Cycles
          </label>
          <input
            id="settings-max-cycles"
            type="number"
            min={1}
            value={maxCycles}
            onChange={(e) => setMaxCycles(Number(e.target.value) || 1)}
            className="w-full rounded border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          />
        </div>

        <div>
          <label
            htmlFor="settings-max-generations"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Max Generations
          </label>
          <input
            id="settings-max-generations"
            type="number"
            min={1}
            value={maxGenerations}
            onChange={(e) => setMaxGenerations(Number(e.target.value) || 1)}
            className="w-full rounded border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saveStatus === "saving"}
            className="rounded bg-gray-900 dark:bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors duration-200 ease-in-out"
          >
            {saveStatus === "saving" ? "Saving…" : "Save"}
          </button>
          {saveStatus === "ok" && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">{saveMessage}</span>
          )}
          {saveStatus === "error" && (
            <span className="text-sm text-red-600 dark:text-red-400">{saveMessage}</span>
          )}
        </div>
      </div>
    </section>
  );
}
