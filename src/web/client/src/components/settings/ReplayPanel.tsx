import { useEffect, useState } from "react";
import { getApiBase } from "../../utils/api";

interface SessionEntry {
  sessionId: string;
  goal: string;
  createdAt: number;
  completedAt: number;
  totalRuns: number;
  averageConfidence: number;
  teamComposition: string[];
  tag?: string;
}

export function ReplayPanel() {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);

  const fetchSessions = () => {
    const base = getApiBase();
    if (!base) return;
    setLoading(true);
    fetch(`${base}/api/replay/sessions`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.sessions)) setSessions(data.sessions);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleReplay = async (sessionId: string) => {
    const base = getApiBase();
    if (!base) return;
    setReplayingId(sessionId);
    await fetch(`${base}/api/replay/sessions/${sessionId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speed }),
    });
  };

  const handleDelete = async (sessionId: string) => {
    const base = getApiBase();
    if (!base) return;
    const res = await fetch(`${base}/api/replay/sessions/${sessionId}`, { method: "DELETE" });
    if (res.ok) {
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    }
  };

  const handleTag = async (sessionId: string) => {
    const label = prompt("Tag label:");
    if (!label) return;
    const base = getApiBase();
    if (!base) return;
    await fetch(`${base}/api/replay/sessions/${sessionId}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    fetchSessions();
  };

  const handleUntag = async (sessionId: string) => {
    const base = getApiBase();
    if (!base) return;
    await fetch(`${base}/api/replay/sessions/${sessionId}/tag`, { method: "DELETE" });
    fetchSessions();
  };

  const badgeGreen = "inline-block rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 text-xs px-2 py-0.5";
  const badgeCyan = "inline-block rounded-full bg-cyan-100 dark:bg-cyan-900 text-cyan-700 dark:text-cyan-300 text-xs px-2 py-0.5";

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300">
        <i className="bi bi-play-circle mr-1" />
        Session Replay
      </h3>

      <div className="flex items-center gap-2">
        <label className="text-xs text-stone-500">Speed:</label>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 text-xs px-2 py-1"
        >
          <option value={0}>Instant</option>
          <option value={0.5}>0.5x</option>
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={5}>5x</option>
        </select>
      </div>

      {loading && <p className="text-xs text-stone-400">Loading sessions...</p>}
      {!loading && sessions.length === 0 && (
        <p className="text-xs text-stone-400 italic">No recorded sessions. Sessions are recorded automatically during work runs.</p>
      )}

      {sessions.map((s) => (
        <div
          key={s.sessionId}
          className="rounded-lg border border-stone-200 dark:border-stone-700 p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300 truncate max-w-[200px]">
              {s.goal || "(no goal)"}
            </span>
            <div className="flex gap-1">
              {s.tag && <span className={badgeCyan}>{s.tag}</span>}
              <span className={badgeGreen}>{s.totalRuns} run{s.totalRuns !== 1 ? "s" : ""}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-1 text-xs text-stone-400">
            <span>{new Date(s.createdAt).toLocaleString()}</span>
            <span>|</span>
            <span>conf: {(s.averageConfidence * 100).toFixed(0)}%</span>
          </div>

          <div className="flex flex-wrap gap-1">
            {s.teamComposition.map((role) => (
              <span key={role} className="text-xs text-stone-400 bg-stone-100 dark:bg-stone-800 rounded px-1.5 py-0.5">
                {role}
              </span>
            ))}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleReplay(s.sessionId)}
              disabled={replayingId === s.sessionId}
              className="text-xs text-emerald-600 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300 transition-colors disabled:opacity-50"
            >
              <i className="bi bi-play-fill mr-1" />
              {replayingId === s.sessionId ? "Replaying..." : "Replay"}
            </button>
            {s.tag ? (
              <button
                type="button"
                onClick={() => handleUntag(s.sessionId)}
                className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
              >
                <i className="bi bi-tag-fill mr-1" />Untag
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleTag(s.sessionId)}
                className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
              >
                <i className="bi bi-tag mr-1" />Tag
              </button>
            )}
            <button
              type="button"
              onClick={() => handleDelete(s.sessionId)}
              className="text-xs text-rose-500 hover:text-rose-700 transition-colors"
            >
              <i className="bi bi-trash mr-1" />Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
