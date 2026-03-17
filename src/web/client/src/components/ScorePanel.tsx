import { useState, useEffect } from "react";

interface BehaviorPattern {
  id: string;
  label: string;
  sentiment: "positive" | "negative" | "neutral";
}

interface ScoreData {
  score: {
    id: string;
    date: string;
    overall: number;
    teamTrust: number;
    reviewEngagement: number;
    warningResponse: number;
    confidenceAlignment: number;
    tip: string;
    patternsJson: string;
    eventsJson: string;
  } | null;
  trend: {
    current: number;
    lastWeek: number | null;
    delta: number | null;
    direction: string;
    history: { date: string; overall: number }[];
  };
}

function scoreColor(score: number): string {
  if (score > 70) return "text-emerald-400";
  if (score > 40) return "text-amber-400";
  return "text-red-400";
}

function scoreBg(score: number): string {
  if (score > 70) return "bg-emerald-500";
  if (score > 40) return "bg-amber-500";
  return "bg-red-500";
}

function DimensionBar({ label, score, max }: { label: string; score: number; max: number }) {
  const pct = Math.min(100, (score / max) * 100);
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-stone-300">{label}</span>
        <span className="text-stone-400">{score.toFixed(1)}/{max}</span>
      </div>
      <div className="h-2 bg-stone-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${scoreBg(score * (100 / max))}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function TrendLine({ history }: { history: { date: string; overall: number }[] }) {
  if (history.length < 2) return null;

  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const maxScore = Math.max(...sorted.map(h => h.overall), 100);
  const width = 200;
  const height = 60;
  const padding = 4;

  const points = sorted.map((h, i) => {
    const x = padding + (i / (sorted.length - 1)) * (width - padding * 2);
    const y = height - padding - ((h.overall / maxScore) * (height - padding * 2));
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="mt-3">
      <div className="text-xs text-stone-400 mb-1">Trend (last {sorted.length} sessions)</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-16">
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-emerald-400"
        />
        {sorted.map((h, i) => {
          const x = padding + (i / (sorted.length - 1)) * (width - padding * 2);
          const y = height - padding - ((h.overall / maxScore) * (height - padding * 2));
          return (
            <circle
              key={h.date}
              cx={x}
              cy={y}
              r="3"
              className="fill-emerald-400"
            />
          );
        })}
      </svg>
    </div>
  );
}

export function ScorePanel() {
  const [data, setData] = useState<ScoreData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/score")
      .then(res => {
        if (!res.ok) throw new Error("Failed to load score");
        return res.json();
      })
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-stone-800 rounded-lg p-4 border border-stone-700">
        <div className="text-stone-400 text-sm">Loading vibe score...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-stone-800 rounded-lg p-4 border border-stone-700">
        <div className="text-stone-500 text-sm">Score unavailable</div>
      </div>
    );
  }

  if (!data.score) {
    return (
      <div className="bg-stone-800 rounded-lg p-4 border border-stone-700">
        <h3 className="text-sm font-medium text-stone-300 mb-2">Vibe Score</h3>
        <div className="text-stone-500 text-sm">No score data yet. Complete a work session to see your collaboration score.</div>
      </div>
    );
  }

  const { score, trend } = data;
  const colorClass = scoreColor(score.overall);
  const dirArrow = trend.direction === "improving" ? " ↑" : trend.direction === "degrading" ? " ↓" : trend.direction === "plateaued" ? " →" : "";

  let patterns: BehaviorPattern[] = [];
  try {
    patterns = JSON.parse(score.patternsJson);
  } catch { /* ignore */ }

  return (
    <div className="bg-stone-800 rounded-lg p-4 border border-stone-700">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-stone-300">Vibe Score</h3>
        <span className="text-xs text-stone-500">{score.date}</span>
      </div>

      {/* Overall score */}
      <div className="text-center mb-4">
        <span className={`text-4xl font-bold ${colorClass}`}>{score.overall}</span>
        <span className="text-stone-500 text-lg">/100</span>
        {dirArrow && <span className={`ml-1 text-sm ${colorClass}`}>{dirArrow}</span>}
        {trend.delta != null && (
          <div className="text-xs text-stone-500 mt-1">
            {trend.delta > 0 ? "+" : ""}{trend.delta.toFixed(1)} from last week
          </div>
        )}
      </div>

      {/* Dimension bars */}
      <div className="space-y-1">
        <DimensionBar label="Team Trust" score={score.teamTrust} max={25} />
        <DimensionBar label="Review Engagement" score={score.reviewEngagement} max={25} />
        <DimensionBar label="Warning Response" score={score.warningResponse} max={25} />
        <DimensionBar label="Confidence Alignment" score={score.confidenceAlignment} max={25} />
      </div>

      {/* Trend line */}
      <TrendLine history={trend.history} />

      {/* Patterns */}
      {patterns.length > 0 && (
        <div className="mt-3 space-y-1">
          {patterns.slice(0, 3).map(p => (
            <div key={p.id} className="text-xs flex items-start gap-1">
              <span className={p.sentiment === "positive" ? "text-emerald-400" : p.sentiment === "negative" ? "text-red-400" : "text-stone-400"}>
                {p.sentiment === "positive" ? "↑" : p.sentiment === "negative" ? "↓" : "→"}
              </span>
              <span className="text-stone-400">{p.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tip */}
      {score.tip && (
        <div className="mt-3 p-2 bg-stone-750 rounded border border-stone-600">
          <div className="text-xs text-cyan-400">{score.tip}</div>
        </div>
      )}
    </div>
  );
}
