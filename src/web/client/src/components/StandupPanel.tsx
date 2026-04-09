import { useState, useEffect } from "react";

interface SessionSummary {
  sessionId: string;
  goal: string;
  tasksCompleted: number;
  reworkCount: number;
  allApproved: boolean;
}

interface BlockedItem {
  type: string;
  description: string;
  sessionId: string;
  priority: "high" | "medium" | "low";
}

interface SuggestionItem {
  type: string;
  description: string;
  reasoning: string;
}

interface StandupData {
  date: string;
  yesterday: {
    sessions: SessionSummary[];
    totalTasks: number;
    teamLearnings: string[];
  };
  blocked: BlockedItem[];
  suggested: SuggestionItem[];
  streak: number;
  globalPatternsCount: number;
}

function PriorityDot({ priority }: { priority: string }) {
  const color =
    priority === "high"
      ? "bg-red-500"
      : priority === "medium"
        ? "bg-amber-500"
        : "bg-blue-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export function StandupPanel() {
  const [data, setData] = useState<StandupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/standup")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load standup");
        return res.json();
      })
      .then((json) => setData(json.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-stone-800 rounded-lg p-4 border border-stone-700">
        <div className="text-stone-400 text-sm">Loading standup...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-stone-800 rounded-lg p-4 border border-stone-700">
        <div className="text-stone-500 text-sm">Standup unavailable</div>
      </div>
    );
  }

  const sessionCount = data.yesterday.sessions.length;

  return (
    <div className="bg-stone-800 rounded-lg p-4 border border-stone-700">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-stone-300">Standup</h3>
        <span className="text-xs text-stone-500">{data.date}</span>
      </div>

      {/* Compact summary */}
      <div className="text-sm text-stone-300 mb-2">
        {sessionCount === 0 ? (
          <span className="text-stone-500">No sessions yesterday</span>
        ) : (
          <span>
            {sessionCount} session{sessionCount !== 1 ? "s" : ""} &middot; {data.yesterday.totalTasks} tasks
          </span>
        )}
      </div>

      {/* Top 2 blocked */}
      {data.blocked.length > 0 && (
        <div className="mb-2 space-y-1">
          {data.blocked.slice(0, 2).map((b, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs">
              <PriorityDot priority={b.priority} />
              <span className="text-amber-300 truncate">
                {b.description.length > 50 ? b.description.slice(0, 47) + "..." : b.description}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Top suggestion */}
      {data.suggested.length > 0 && (
        <div className="text-xs text-cyan-400 mb-2">
          {data.suggested[0]!.description}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-3 text-xs text-stone-500">
        {data.streak > 0 && <span>{data.streak}-day streak</span>}
        {data.globalPatternsCount > 0 && <span>{data.globalPatternsCount} patterns</span>}
      </div>

      {/* Expand toggle */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs text-stone-500 hover:text-stone-300 transition-colors"
      >
        {expanded ? "Show less" : "Show full standup"}
      </button>

      {/* Expanded view */}
      {expanded && (
        <div className="mt-3 border-t border-stone-700 pt-3 space-y-3">
          {/* All sessions */}
          {data.yesterday.sessions.length > 0 && (
            <div>
              <div className="text-xs font-medium text-stone-400 mb-1">Sessions</div>
              {data.yesterday.sessions.map((s) => (
                <div key={s.sessionId} className="text-xs text-stone-300 mb-1">
                  <span className="text-emerald-400">{s.goal}</span>
                  <span className="text-stone-500 ml-1">
                    — {s.tasksCompleted} tasks{s.reworkCount > 0 ? `, ${s.reworkCount} rework` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* All blocked */}
          {data.blocked.length > 2 && (
            <div>
              <div className="text-xs font-medium text-stone-400 mb-1">All blocked ({data.blocked.length})</div>
              {data.blocked.slice(2).map((b, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs mb-1">
                  <PriorityDot priority={b.priority} />
                  <span className="text-amber-300">{b.description}</span>
                </div>
              ))}
            </div>
          )}

          {/* All suggestions */}
          {data.suggested.length > 1 && (
            <div>
              <div className="text-xs font-medium text-stone-400 mb-1">Suggestions</div>
              {data.suggested.slice(1).map((s, i) => (
                <div key={i} className="text-xs text-cyan-400 mb-1">{s.description}</div>
              ))}
            </div>
          )}

          {/* Learnings */}
          {data.yesterday.teamLearnings.length > 0 && (
            <div>
              <div className="text-xs font-medium text-stone-400 mb-1">Learnings</div>
              {data.yesterday.teamLearnings.slice(0, 3).map((l, i) => (
                <div key={i} className="text-xs text-blue-400 mb-1">{l}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
