/**
 * Learning Curve chart — shows confidence and auto-approval trends across runs.
 * Uses lightweight SVG rendering (no external charting dependency required).
 */

export interface LearningCurveProps {
  sessionId: string;
  runs: LearningCurvePoint[];
}

export interface LearningCurvePoint {
  runIndex: number;
  averageConfidence: number;
  autoApprovedPct: number;
}

type Metric = "confidence" | "autoApproved";

import { useState } from "react";

const CHART_W = 500;
const CHART_H = 200;
const PAD = { top: 20, right: 20, bottom: 30, left: 50 };

export function LearningCurve({ sessionId, runs }: LearningCurveProps) {
  const [metric, setMetric] = useState<Metric>("confidence");

  if (runs.length < 2) {
    return (
      <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Need at least 2 runs for a learning curve.
        </p>
      </div>
    );
  }

  const values = runs.map((r) => {
    if (metric === "confidence") return r.averageConfidence;
    return r.autoApprovedPct;
  });

  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;

  const w = CHART_W - PAD.left - PAD.right;
  const h = CHART_H - PAD.top - PAD.bottom;

  const points = values.map((v, i) => ({
    x: PAD.left + (i / (values.length - 1)) * w,
    y: PAD.top + h - ((v - minVal) / range) * h,
  }));

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const lineColor = metric === "confidence" ? "#10b981" : "#6366f1";

  const label = metric === "confidence" ? "Avg Confidence" : "Auto-Approved %";
  const formatter = metric === "confidence" ? (v: number) => v.toFixed(2) : (v: number) => `${(v * 100).toFixed(0)}%`;

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-stone-600 dark:text-stone-400">
          Learning Curve — {sessionId}
        </h4>
        <div className="flex gap-1">
          {(["confidence", "autoApproved"] as Metric[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                metric === m
                  ? "bg-amber-500 text-white"
                  : "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400"
              }`}
            >
              {m === "confidence" ? "Confidence" : "Auto-Approved"}
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" style={{ maxHeight: 220 }}>
        {/* Y-axis labels */}
        <text x={PAD.left - 8} y={PAD.top + 4} textAnchor="end" className="fill-stone-400 text-[10px]">
          {formatter(maxVal)}
        </text>
        <text x={PAD.left - 8} y={PAD.top + h + 4} textAnchor="end" className="fill-stone-400 text-[10px]">
          {formatter(minVal)}
        </text>

        {/* Grid lines */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left + w} y2={PAD.top} stroke="currentColor" strokeOpacity={0.1} />
        <line x1={PAD.left} y1={PAD.top + h} x2={PAD.left + w} y2={PAD.top + h} stroke="currentColor" strokeOpacity={0.1} />
        <line x1={PAD.left} y1={PAD.top + h / 2} x2={PAD.left + w} y2={PAD.top + h / 2} stroke="currentColor" strokeOpacity={0.1} strokeDasharray="4 4" />

        {/* Line */}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />

        {/* Data points */}
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={4} fill={lineColor} />
            <text x={p.x} y={CHART_H - 8} textAnchor="middle" className="fill-stone-400 text-[10px]">
              Run {runs[i].runIndex}
            </text>
            <title>{`Run ${runs[i].runIndex}: ${formatter(values[i])}`}</title>
          </g>
        ))}

        {/* Y-axis label */}
        <text x={12} y={PAD.top + h / 2} textAnchor="middle" transform={`rotate(-90, 12, ${PAD.top + h / 2})`} className="fill-stone-500 text-[10px]">
          {label}
        </text>
      </svg>
    </div>
  );
}
