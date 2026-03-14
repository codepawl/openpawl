import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { useWsStore } from "../ws";
import { getApiBase } from "../utils/api";
import { ModelSettings } from "./settings/ModelSettings";
import { PaletteSettings } from "./settings/PaletteSettings";
import { WebhookSettings } from "./settings/WebhookSettings";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
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
  const [sessionMode, setSessionMode] = useState<"runs" | "time">(
    (config?.session_mode as string) === "time" ? "time" : "runs"
  );
  const [maxGenerations, setMaxGenerations] = useState(
    Number(config?.max_generations ?? 5)
  );
  const [sessionDuration, setSessionDuration] = useState(
    Number(config?.session_duration ?? 30)
  );
  const [webhookOnTaskComplete, setWebhookOnTaskComplete] = useState("");
  const [webhookOnCycleEnd, setWebhookOnCycleEnd] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
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
      const sd = Number(config.session_duration);
      if (Number.isFinite(c)) setCreativity(c);
      if (Number.isFinite(mc)) setMaxCycles(mc);
      if (Number.isFinite(mg)) setMaxGenerations(mg);
      if (Number.isFinite(sd)) setSessionDuration(sd);
      if ((config.session_mode as string) === "time" || (config.session_mode as string) === "runs") {
        setSessionMode(config.session_mode as "runs" | "time");
      }
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
        const sd = Number(data.session_duration);
        if (Number.isFinite(c)) setCreativity(c);
        if (Number.isFinite(mc)) setMaxCycles(mc);
        if (Number.isFinite(mg)) setMaxGenerations(mg);
        if (Number.isFinite(sd)) setSessionDuration(sd);
        if ((data.session_mode as string) === "time" || (data.session_mode as string) === "runs") {
          setSessionMode(data.session_mode as "runs" | "time");
        }
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
          creativity: Math.max(0, Math.min(1, creativity)),
          max_cycles: Math.max(1, Math.floor(maxCycles)),
          session_mode: sessionMode,
          ...(sessionMode === "runs"
            ? { max_generations: Math.max(1, Math.floor(maxGenerations)) }
            : { session_duration: Math.max(1, Math.floor(sessionDuration)) }),
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
          session_mode: sessionMode,
          ...(sessionMode === "runs"
            ? { max_generations: Math.max(1, Math.floor(maxGenerations)) }
            : { session_duration: Math.max(1, Math.floor(sessionDuration)) }),
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

  const inputClass = "w-full rounded-lg border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 text-sm text-stone-800 dark:text-stone-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150 placeholder:text-stone-400 dark:placeholder:text-stone-500";
  const selectClass = "w-full appearance-none rounded-lg border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 pr-9 text-sm text-stone-800 dark:text-stone-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150 bg-[length:16px_16px] bg-[position:right_0.625rem_center] bg-no-repeat bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='%2378716c' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m2 5 6 6 6-6'/%3E%3C/svg%3E\")]";
  const tabBase = "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors text-center";
  const tabActive = `${tabBase} bg-stone-800 dark:bg-stone-600 text-white`;
  const tabInactive = `${tabBase} text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300`;

  return (
      <motion.aside
        className="shrink-0 bg-white dark:bg-stone-900 shadow-lg border-l border-stone-200 dark:border-stone-700 overflow-auto"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: 384, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-stone-200 dark:border-stone-700 px-6 py-4">
            <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-100"><i className="bi bi-gear-fill mr-2" />Settings</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
            >
              <i className="bi bi-x-lg text-lg" />
            </button>
          </div>

          <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
            <div className="border-b border-stone-200 dark:border-stone-700 pb-4">
              <PaletteSettings />
            </div>

            <div>
              <label htmlFor="settings-template" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                Team Template
              </label>
              <select id="settings-template" value={template} onChange={(e) => setTemplate(e.target.value)} className={selectClass}>
                <option value="game_dev">Game Dev (Programmers, Artist, SFX, Designer)</option>
                <option value="startup">Startup (Engineers, PM, Designer)</option>
                <option value="content">Content (Writer, Editor, Designer)</option>
              </select>
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Takes effect on next session start.</p>
            </div>

            <div>
              <label htmlFor="settings-goal" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                Goal
              </label>
              <textarea
                id="settings-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={3}
                placeholder="e.g. Build a simple 2D platformer with sprite assets and sound effects"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Takes effect on next session start.</p>
            </div>

            <div>
              <label htmlFor="settings-worker" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                OpenClaw Worker URL
              </label>
              <input
                id="settings-worker"
                type="text"
                value={workerUrl}
                onChange={(e) => setWorkerUrl(e.target.value)}
                placeholder="http://localhost:8001"
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="settings-creativity" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                Creativity (0-1)
              </label>
              <input
                id="settings-creativity"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={creativity}
                onChange={(e) => setCreativity(Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="settings-max-cycles" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                Max Cycles per Run
              </label>
              <input
                id="settings-max-cycles"
                type="number"
                min={1}
                value={maxCycles}
                onChange={(e) => setMaxCycles(Number(e.target.value) || 1)}
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium text-stone-600 dark:text-stone-400">
                Session Limit
              </label>
              <div className="flex gap-1 rounded-lg bg-stone-100 dark:bg-stone-800 p-1 mb-3">
                <button
                  type="button"
                  className={sessionMode === "runs" ? tabActive : tabInactive}
                  onClick={() => setSessionMode("runs")}
                >
                  By Runs
                </button>
                <button
                  type="button"
                  className={sessionMode === "time" ? tabActive : tabInactive}
                  onClick={() => setSessionMode("time")}
                >
                  By Time
                </button>
              </div>

              {sessionMode === "runs" ? (
                <div>
                  <label htmlFor="settings-max-generations" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                    Number of Runs
                  </label>
                  <input
                    id="settings-max-generations"
                    type="number"
                    min={1}
                    value={maxGenerations}
                    onChange={(e) => setMaxGenerations(Number(e.target.value) || 1)}
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">Session ends after all runs complete.</p>
                </div>
              ) : (
                <div>
                  <label htmlFor="settings-session-duration" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                    Duration (minutes)
                  </label>
                  <input
                    id="settings-session-duration"
                    type="number"
                    min={1}
                    value={sessionDuration}
                    onChange={(e) => setSessionDuration(Number(e.target.value) || 30)}
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">Session ends when time runs out.</p>
                </div>
              )}
            </div>

            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <ModelSettings />
            </div>

            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <WebhookSettings
                webhookOnTaskComplete={webhookOnTaskComplete}
                webhookOnCycleEnd={webhookOnCycleEnd}
                webhookSecret={webhookSecret}
                onChange={(field, value) => {
                  if (field === "webhookOnTaskComplete") setWebhookOnTaskComplete(value);
                  else if (field === "webhookOnCycleEnd") setWebhookOnCycleEnd(value);
                  else if (field === "webhookSecret") setWebhookSecret(value);
                }}
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saveStatus === "saving"}
                className="rounded-lg bg-stone-800 dark:bg-stone-700 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 dark:hover:bg-stone-600 disabled:opacity-50 transition-colors active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-stone-500/30"
              >
                <i className={`bi ${saveStatus === "saving" ? "bi-arrow-repeat" : "bi-floppy"} mr-1`} />
                {saveStatus === "saving" ? "Saving..." : "Save"}
              </button>
              {saveStatus === "ok" && (
                <span className="text-sm text-emerald-600 dark:text-emerald-400">{saveMessage}</span>
              )}
              {saveStatus === "error" && (
                <span className="text-sm text-rose-600 dark:text-rose-400">{saveMessage}</span>
              )}
            </div>
          </div>
        </div>
      </motion.aside>
  );
}
