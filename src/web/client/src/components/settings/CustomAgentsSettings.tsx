import { useEffect, useState } from "react";
import { getApiBase } from "../../utils/api";

interface CustomAgent {
  role: string;
  displayName: string;
  description: string;
  source: string;
  registeredAt: string;
  taskTypes: string[];
  compositionRules: {
    includeKeywords?: string[];
    excludeKeywords?: string[];
    required?: boolean;
  } | null;
}

export function CustomAgentsSettings() {
  const [agents, setAgents] = useState<CustomAgent[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAgents = () => {
    const base = getApiBase();
    if (!base) return;
    setLoading(true);
    fetch(`${base}/api/agents/custom`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.agents)) setAgents(data.agents);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const handleRemove = async (role: string) => {
    const base = getApiBase();
    if (!base) return;
    const res = await fetch(`${base}/api/agents/custom/${role}`, { method: "DELETE" });
    if (res.ok) {
      setAgents((prev) => prev.filter((a) => a.role !== role));
    }
  };

  const badgeBlue = "inline-block rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs px-2 py-0.5";
  const badgeGreen = "inline-block rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 text-xs px-2 py-0.5";

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300">
        <i className="bi bi-robot mr-1" />
        Custom Agents
      </h3>

      <p className="text-xs text-stone-500 dark:text-stone-400">
        Register custom agents via <code className="text-amber-600 dark:text-amber-400">teamclaw agent add &lt;file&gt;</code>.
        Custom agents participate in task dispatch alongside built-in workers.
      </p>

      {loading && <p className="text-xs text-stone-400">Loading...</p>}
      {!loading && agents.length === 0 && (
        <p className="text-xs text-stone-400 italic">No custom agents registered.</p>
      )}

      {agents.map((agent) => (
        <div
          key={agent.role}
          className="rounded-lg border border-stone-200 dark:border-stone-700 p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              {agent.displayName}
            </span>
            <button
              type="button"
              onClick={() => handleRemove(agent.role)}
              className="text-xs text-rose-500 hover:text-rose-700 dark:hover:text-rose-400 transition-colors"
            >
              <i className="bi bi-trash mr-1" />Remove
            </button>
          </div>

          <p className="text-xs text-stone-500 dark:text-stone-400">
            {agent.description}
          </p>

          <div className="flex flex-wrap gap-1">
            <span className={badgeBlue}>{agent.role}</span>
            {agent.taskTypes.map((t) => (
              <span key={t} className={badgeGreen}>{t}</span>
            ))}
          </div>

          {agent.compositionRules?.includeKeywords?.length ? (
            <p className="text-xs text-stone-400">
              Keywords: {agent.compositionRules.includeKeywords.join(", ")}
            </p>
          ) : null}

          <p className="text-xs text-stone-400">
            {new Date(agent.registeredAt).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}
