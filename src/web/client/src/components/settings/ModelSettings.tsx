import { useEffect, useState } from "react";
import { useWsStore } from "../../ws";

function getApiBase(): string {
  if (typeof location === "undefined") return "";
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env && typeof env === "string") {
    const base = env.replace(/^ws:/, "http:").replace(/\/ws\/?$/, "");
    if (base) return base;
  }
  return location.origin;
}

interface ModelState {
  available: string[];
  default_model: string;
  agent_models: Record<string, string>;
  fallback_chain: string[];
  aliases: Record<string, string>;
  allowlist: string[];
}

const KNOWN_ROLES = [
  "coordinator", "planner", "architect", "rfc",
  "analyst", "retrospective", "worker",
];

const inputClass = "w-full rounded-lg border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 text-sm text-stone-800 dark:text-stone-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150 placeholder:text-stone-400 dark:placeholder:text-stone-500";
const selectClass = "w-full appearance-none rounded-lg border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 pr-9 text-sm text-stone-800 dark:text-stone-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150 bg-[length:16px_16px] bg-[position:right_0.625rem_center] bg-no-repeat bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='%2378716c' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m2 5 6 6 6-6'/%3E%3C/svg%3E\")]";
const btnClass = "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors";
const btnPrimary = `${btnClass} bg-stone-800 dark:bg-stone-700 text-white hover:bg-stone-700 dark:hover:bg-stone-600 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-stone-500/30`;
const btnSecondary = `${btnClass} border border-stone-300 dark:border-stone-600 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-stone-400/20`;

export function ModelSettings() {
  const sendMessage = useWsStore((s) => s.sendMessage);
  const modelConfig = useWsStore((s) => s.modelConfig);
  const [models, setModels] = useState<ModelState | null>(null);
  const [selectedDefault, setSelectedDefault] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function fetchModels() {
    setLoading(true);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/models`);
      const data = (await res.json()) as ModelState;
      setModels(data);
      setSelectedDefault(data.default_model);
    } catch {
      setStatus("Failed to load models");
    }
    setLoading(false);
  }

  useEffect(() => { fetchModels(); }, []);

  useEffect(() => {
    if (modelConfig) {
      setModels((prev) => prev ? {
        ...prev,
        default_model: modelConfig.defaultModel,
        agent_models: modelConfig.agentModels,
        fallback_chain: modelConfig.fallbackChain,
        aliases: modelConfig.aliases,
        allowlist: modelConfig.allowlist,
        available: modelConfig.availableModels.length > 0 ? modelConfig.availableModels : (prev?.available ?? []),
      } : prev);
      setSelectedDefault(modelConfig.defaultModel);
    }
  }, [modelConfig]);

  function switchModel(model: string, agent?: string) {
    sendMessage({ command: "model_switch", model, agent });
    setStatus(`Switching ${agent ? `${agent} model` : "default model"} to ${model}...`);
    setTimeout(() => setStatus(null), 2000);
  }

  function handleDefaultSwitch() {
    const model = selectedDefault === "__custom__" ? customModel.trim() : selectedDefault;
    if (model) switchModel(model);
  }

  function handleAgentSwitch(role: string, model: string) {
    if (model === "__default__") {
      switchModel("", role);
    } else {
      switchModel(model, role);
    }
  }

  if (!models) {
    return <div className="text-sm text-stone-500">{loading ? "Loading models..." : "No model data"}</div>;
  }

  const available = models.available;
  const aliasEntries = Object.entries(models.aliases);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300">Model Management</h3>
        <button type="button" onClick={fetchModels} disabled={loading} className={btnSecondary}>
          {loading ? "Refreshing..." : "Refresh Models"}
        </button>
      </div>

      {status && <p className="text-xs text-amber-600 dark:text-amber-400">{status}</p>}

      <div>
        <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
          Default Model
        </label>
        <div className="flex gap-2">
          <select
            value={selectedDefault}
            onChange={(e) => setSelectedDefault(e.target.value)}
            className={selectClass}
          >
            {available.map((m) => (
              <option key={m} value={m}>{m}{m === models.default_model ? " (current)" : ""}</option>
            ))}
            <option value="__custom__">Custom...</option>
          </select>
          <button type="button" onClick={handleDefaultSwitch} className={btnPrimary}>Apply</button>
        </div>
        {selectedDefault === "__custom__" && (
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="Enter model ID"
            className={`${inputClass} mt-2`}
          />
        )}
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-stone-600 dark:text-stone-400">
          Per-Agent Overrides
        </label>
        <div className="space-y-2">
          {KNOWN_ROLES.map((role) => {
            const current = models.agent_models[role] ?? "";
            return (
              <div key={role} className="flex items-center gap-2">
                <span className="w-28 text-xs text-stone-600 dark:text-stone-400 capitalize">{role}</span>
                <select
                  value={current || "__default__"}
                  onChange={(e) => handleAgentSwitch(role, e.target.value)}
                  className={`${selectClass} flex-1`}
                >
                  <option value="__default__">Use default</option>
                  {available.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {models.fallback_chain.length > 0 && (
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Fallback Chain
          </label>
          <div className="mt-1.5 space-y-0">
            {models.fallback_chain.map((model, i) => {
              const parts = model.split("/");
              const provider = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
              const name = parts[parts.length - 1];
              const isActive = model === models.default_model;
              return (
                <div key={model} className="flex items-stretch gap-2">
                  <div className="flex flex-col items-center w-5 shrink-0">
                    <div className={`h-2.5 w-2.5 rounded-full border-2 mt-1.5 shrink-0 ${isActive ? "border-amber-500 bg-amber-500" : "border-stone-400 dark:border-stone-500 bg-transparent"}`} />
                    {i < models.fallback_chain.length - 1 && (
                      <div className="w-px flex-1 bg-stone-300 dark:bg-stone-600" />
                    )}
                  </div>
                  <div className="pb-2.5 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-stone-400 dark:text-stone-500 tabular-nums">{i + 1}.</span>
                      <span className={`text-xs font-mono truncate ${isActive ? "text-amber-600 dark:text-amber-400 font-semibold" : "text-stone-700 dark:text-stone-300"}`}>{name}</span>
                      {isActive && <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 rounded-full shrink-0">active</span>}
                    </div>
                    {provider && (
                      <span className="text-[10px] text-stone-400 dark:text-stone-500 font-mono">{provider}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {aliasEntries.length > 0 && (
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Aliases
          </label>
          <div className="text-xs text-stone-500 dark:text-stone-400 space-y-0.5">
            {aliasEntries.map(([alias, target]) => (
              <div key={alias}><span className="font-mono">{alias}</span> → {target}</div>
            ))}
          </div>
        </div>
      )}

      {models.allowlist.length > 0 && (
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Allowlist
          </label>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {models.allowlist.join(", ")}
          </p>
        </div>
      )}
    </div>
  );
}
