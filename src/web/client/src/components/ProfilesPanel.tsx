import { useState, useEffect } from "react";
import { getApiBase } from "../utils/api";

interface TaskTypeScore {
  taskType: string;
  averageConfidence: number;
  successRate: number;
  averageReworkCount: number;
  totalTasksCompleted: number;
  trend: "improving" | "stable" | "degrading";
}

interface AgentProfile {
  agentRole: string;
  taskTypeScores: TaskTypeScore[];
  overallScore: number;
  strengths: string[];
  weaknesses: string[];
  lastUpdatedAt: number;
  totalTasksCompleted: number;
  scoreHistory: number[];
}

interface RoutingDecision {
  taskId: string;
  assignedAgent: string;
  reason: string;
  alternativeAgents: Array<{ role: string; score: number }>;
  profileConfidence: number;
}

interface ProfileAlert {
  agentRole: string;
  previousScore: number;
  currentScore: number;
  alertAt: number;
}

function ScoreBar({ score, width = 120 }: { score: number; width?: number }) {
  const pct = Math.max(0, Math.min(1, score));
  const fill = pct >= 0.8 ? "#22c55e" : pct >= 0.5 ? "#eab308" : "#ef4444";
  return (
    <svg width={width} height={16} className="inline-block align-middle">
      <rect x={0} y={2} width={width} height={12} rx={4} fill="currentColor" className="text-stone-200 dark:text-stone-700" />
      <rect x={0} y={2} width={pct * width} height={12} rx={4} fill={fill} />
      <text x={width / 2} y={12} textAnchor="middle" fontSize={9} fill="white" fontWeight="bold">
        {(pct * 100).toFixed(0)}%
      </text>
    </svg>
  );
}

function TrendArrow({ trend }: { trend: string }) {
  if (trend === "improving") return <span className="text-green-500 font-bold">&#8593;</span>;
  if (trend === "degrading") return <span className="text-red-500 font-bold">&#8595;</span>;
  return <span className="text-stone-400">&rarr;</span>;
}

function ProfileCard({ profile }: { profile: AgentProfile }) {
  const [expanded, setExpanded] = useState(false);
  const lastScores = profile.scoreHistory.slice(-3);
  let overallTrend: "improving" | "stable" | "degrading" = "stable";
  if (lastScores.length >= 2) {
    const diff = lastScores[lastScores.length - 1] - lastScores[lastScores.length - 2];
    if (diff > 0.02) overallTrend = "improving";
    else if (diff < -0.02) overallTrend = "degrading";
  }

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-3">
          <div>
            <div className="font-medium text-sm text-stone-800 dark:text-stone-200">
              {profile.agentRole} <TrendArrow trend={overallTrend} />
            </div>
            <div className="text-xs text-stone-500">{profile.totalTasksCompleted} tasks</div>
          </div>
        </div>
        <ScoreBar score={profile.overallScore} />
      </button>

      <div className="mt-2 flex flex-wrap gap-1">
        {profile.strengths.map((s) => (
          <span key={s} className="rounded-full bg-green-100 dark:bg-green-900 px-2 py-0.5 text-xs text-green-800 dark:text-green-200">
            {s}
          </span>
        ))}
        {profile.weaknesses.map((w) => (
          <span key={w} className="rounded-full bg-red-100 dark:bg-red-900 px-2 py-0.5 text-xs text-red-800 dark:text-red-200">
            {w}
          </span>
        ))}
      </div>

      {expanded && profile.taskTypeScores.length > 0 && (
        <div className="mt-3 border-t border-stone-200 dark:border-stone-700 pt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-stone-500 text-left">
                <th className="pb-1">Type</th>
                <th className="pb-1">Success</th>
                <th className="pb-1">Conf.</th>
                <th className="pb-1">Rework</th>
                <th className="pb-1">Tasks</th>
                <th className="pb-1">Trend</th>
              </tr>
            </thead>
            <tbody>
              {profile.taskTypeScores.map((s) => (
                <tr key={s.taskType} className="text-stone-700 dark:text-stone-300">
                  <td className="py-0.5">{s.taskType}</td>
                  <td>{(s.successRate * 100).toFixed(0)}%</td>
                  <td>{(s.averageConfidence * 100).toFixed(0)}%</td>
                  <td>{s.averageReworkCount.toFixed(1)}</td>
                  <td>{s.totalTasksCompleted}</td>
                  <td><TrendArrow trend={s.trend} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ProfilesPanel() {
  const [tab, setTab] = useState<"profiles" | "routing" | "alerts">("profiles");
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [decisions, setDecisions] = useState<RoutingDecision[]>([]);
  const [alerts, setAlerts] = useState<ProfileAlert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const base = getApiBase();
    setLoading(true);

    Promise.all([
      fetch(`${base}/api/profiles`).then((r) => r.json()).catch(() => ({ profiles: [] })),
      fetch(`${base}/api/profiles/routing-decisions`).then((r) => r.json()).catch(() => ({ decisions: [] })),
    ]).then(([profilesData, decisionsData]) => {
      const loadedProfiles = (profilesData as { profiles: AgentProfile[] }).profiles ?? [];
      setProfiles(loadedProfiles);
      setDecisions((decisionsData as { decisions: RoutingDecision[] }).decisions ?? []);

      // Derive alerts from profiles with sufficient history
      const derivedAlerts: ProfileAlert[] = [];
      for (const p of loadedProfiles) {
        if (p.scoreHistory.length >= 20) {
          const oldest = p.scoreHistory[0];
          const newest = p.scoreHistory[p.scoreHistory.length - 1];
          if (newest - oldest < -0.1) {
            derivedAlerts.push({
              agentRole: p.agentRole,
              previousScore: oldest,
              currentScore: newest,
              alertAt: p.lastUpdatedAt,
            });
          }
        }
      }
      setAlerts(derivedAlerts);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div className="text-sm text-stone-500 py-4 text-center">Loading profiles...</div>;
  }

  const tabs = ["profiles", "routing", "alerts"] as const;

  return (
    <div>
      <div className="mb-3 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
              tab === t
                ? "bg-stone-700 text-white"
                : "text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
            }`}
          >
            {t === "profiles" ? "Profiles" : t === "routing" ? "Routing" : `Alerts${alerts.length > 0 ? ` (${alerts.length})` : ""}`}
          </button>
        ))}
      </div>

      {tab === "profiles" && (
        <div className="space-y-2">
          {profiles.length === 0 ? (
            <div className="text-sm text-stone-500 text-center py-4">
              No profiles yet. Run a work session to build agent profiles.
            </div>
          ) : (
            profiles.map((p) => <ProfileCard key={p.agentRole} profile={p} />)
          )}
        </div>
      )}

      {tab === "routing" && (
        <div className="overflow-x-auto">
          {decisions.length === 0 ? (
            <div className="text-sm text-stone-500 text-center py-4">
              No routing decisions in current session.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-stone-500 text-left border-b border-stone-200 dark:border-stone-700">
                  <th className="pb-2 pr-3">Task</th>
                  <th className="pb-2 pr-3">Agent</th>
                  <th className="pb-2 pr-3">Reason</th>
                  <th className="pb-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d, i) => (
                  <tr key={i} className="text-stone-700 dark:text-stone-300 border-b border-stone-100 dark:border-stone-800">
                    <td className="py-1.5 pr-3 font-mono">{d.taskId}</td>
                    <td className="py-1.5 pr-3">{d.assignedAgent}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`rounded px-1.5 py-0.5 ${
                        d.reason === "profile_suggests_reroute"
                          ? "bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200"
                          : d.reason === "profile_confirms_assignment"
                            ? "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200"
                            : "bg-stone-100 dark:bg-stone-800 text-stone-600"
                      }`}>
                        {d.reason.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="py-1.5">{d.profileConfidence > 0 ? (d.profileConfidence * 100).toFixed(0) + "%" : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "alerts" && (
        <div className="space-y-2">
          {alerts.length === 0 ? (
            <div className="text-sm text-stone-500 text-center py-4">
              No degradation alerts.
            </div>
          ) : (
            alerts.map((a, i) => (
              <div key={i} className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950 p-3">
                <div className="text-sm font-medium text-red-800 dark:text-red-200">
                  {a.agentRole}
                </div>
                <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                  Score dropped from {(a.previousScore * 100).toFixed(0)}% to {(a.currentScore * 100).toFixed(0)}%
                </div>
                <div className="text-xs text-red-500 mt-0.5">
                  {new Date(a.alertAt).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
