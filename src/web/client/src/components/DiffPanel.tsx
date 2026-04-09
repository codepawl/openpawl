import { useState } from "react";

export interface DiffPanelProps {
  sessionId: string;
  totalRuns: number;
  runDiffs: RunDiffData[];
  overallTrend?: OverallTrendData;
}

export interface RunDiffData {
  fromRun: number;
  toRun: number;
  taskDiffs: TaskDiffData[];
  metricDiffs: {
    averageConfidenceDelta: number;
    totalCostDelta: number;
    totalDurationDelta: number;
    reworkCountDelta: number;
    autoApprovedDelta: number;
    tasksAddedCount: number;
    tasksRemovedCount: number;
  };
  memoryDiff: {
    patternsRetrievedDelta: number;
    newPatternsStoredDelta: number;
    globalPromotionsDelta: number;
  };
}

export interface TaskDiffData {
  taskId: string;
  description: string;
  status: "added" | "removed" | "changed" | "unchanged";
  confidenceDelta?: number;
}

export interface OverallTrendData {
  confidenceTrend: "improving" | "stable" | "degrading";
  learningEfficiency: number;
  plateauDetected: boolean;
  plateauMessage?: string;
}

function trendColor(trend: string): string {
  if (trend === "improving") return "text-emerald-600 dark:text-emerald-400";
  if (trend === "degrading") return "text-rose-600 dark:text-rose-400";
  return "text-stone-500 dark:text-stone-400";
}

function trendArrow(trend: string): string {
  if (trend === "improving") return "\u2191\u2191";
  if (trend === "degrading") return "\u2193\u2193";
  return "\u2192\u2192";
}

function deltaColor(delta: number, lowerIsBetter = false): string {
  const positive = lowerIsBetter ? delta < 0 : delta > 0;
  const negative = lowerIsBetter ? delta > 0 : delta < 0;
  if (positive) return "text-emerald-600 dark:text-emerald-400";
  if (negative) return "text-rose-600 dark:text-rose-400";
  return "text-stone-500 dark:text-stone-400";
}

function statusSymbol(status: string): { symbol: string; color: string } {
  switch (status) {
    case "added": return { symbol: "+", color: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" };
    case "removed": return { symbol: "-", color: "bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800" };
    case "changed": return { symbol: "~", color: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800" };
    default: return { symbol: "=", color: "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border-stone-200 dark:border-stone-700" };
  }
}

export function DiffPanel({ totalRuns, runDiffs, overallTrend }: DiffPanelProps) {
  const [selectedPair, setSelectedPair] = useState(0);
  const [showUnchanged, setShowUnchanged] = useState(false);

  if (runDiffs.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Need at least 2 runs to show a diff. Current session has {totalRuns} run(s).
        </p>
      </div>
    );
  }

  const currentDiff = runDiffs[selectedPair];

  return (
    <div className="space-y-4">
      {/* Run Selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-stone-600 dark:text-stone-400">Compare:</span>
        {runDiffs.map((diff, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelectedPair(i)}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
              selectedPair === i
                ? "bg-amber-500 text-white"
                : "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
            }`}
          >
            Run {diff.fromRun} → {diff.toRun}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
          <input
            type="checkbox"
            checked={showUnchanged}
            onChange={(e) => setShowUnchanged(e.target.checked)}
            className="rounded"
          />
          Show unchanged
        </label>
      </div>

      {/* Plateau Warning */}
      {overallTrend?.plateauDetected && overallTrend.plateauMessage && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <i className="bi bi-exclamation-triangle mr-1" />
          {overallTrend.plateauMessage}
        </div>
      )}

      {/* Metrics Bar */}
      <div className="grid grid-cols-4 gap-2">
        <MetricCard label="Confidence" delta={currentDiff.metricDiffs.averageConfidenceDelta} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`} />
        <MetricCard label="Duration" delta={currentDiff.metricDiffs.totalDurationDelta} format={(v) => `${v >= 0 ? "+" : ""}${Math.round(v / 1000)}s`} lowerIsBetter />
        <MetricCard label="Reworks" delta={currentDiff.metricDiffs.reworkCountDelta} format={(v) => `${v >= 0 ? "+" : ""}${v}`} lowerIsBetter />
        <MetricCard label="Auto-approved" delta={currentDiff.metricDiffs.autoApprovedDelta} format={(v) => `${v >= 0 ? "+" : ""}${v}`} />
      </div>

      {/* Task Diffs */}
      <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 divide-y divide-stone-100 dark:divide-stone-800">
        <div className="px-4 py-2 text-xs font-semibold text-stone-600 dark:text-stone-400">
          Tasks ({currentDiff.taskDiffs.filter((t) => t.status !== "unchanged").length} changed)
        </div>
        {currentDiff.taskDiffs
          .filter((t) => showUnchanged || t.status !== "unchanged")
          .map((task) => {
            const { symbol, color } = statusSymbol(task.status);
            return (
              <div key={task.taskId} className={`flex items-center gap-3 px-4 py-2 ${task.status === "unchanged" ? "opacity-50" : ""}`}>
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs font-mono font-bold border ${color}`}>
                  {symbol}
                </span>
                <span className="text-xs font-mono text-stone-500 dark:text-stone-400 w-12 shrink-0">{task.taskId}</span>
                <span className="text-sm text-stone-700 dark:text-stone-200 truncate flex-1">{task.description}</span>
                {task.confidenceDelta != null && task.status !== "removed" && (
                  <span className={`text-xs font-medium ${deltaColor(task.confidenceDelta)}`}>
                    {task.confidenceDelta >= 0 ? "+" : ""}{task.confidenceDelta.toFixed(2)}
                  </span>
                )}
              </div>
            );
          })}
      </div>

      {/* Memory Impact */}
      <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
        <h4 className="text-xs font-semibold text-stone-600 dark:text-stone-400 mb-2">Memory Impact</h4>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className={`text-lg font-bold ${deltaColor(currentDiff.memoryDiff.patternsRetrievedDelta)}`}>
              {currentDiff.memoryDiff.patternsRetrievedDelta >= 0 ? "+" : ""}{currentDiff.memoryDiff.patternsRetrievedDelta}
            </div>
            <div className="text-xs text-stone-500 dark:text-stone-400">Patterns Retrieved</div>
          </div>
          <div>
            <div className={`text-lg font-bold ${deltaColor(currentDiff.memoryDiff.newPatternsStoredDelta, true)}`}>
              {currentDiff.memoryDiff.newPatternsStoredDelta >= 0 ? "+" : ""}{currentDiff.memoryDiff.newPatternsStoredDelta}
            </div>
            <div className="text-xs text-stone-500 dark:text-stone-400">New Patterns</div>
          </div>
          <div>
            <div className={`text-lg font-bold ${deltaColor(currentDiff.memoryDiff.globalPromotionsDelta)}`}>
              {currentDiff.memoryDiff.globalPromotionsDelta >= 0 ? "+" : ""}{currentDiff.memoryDiff.globalPromotionsDelta}
            </div>
            <div className="text-xs text-stone-500 dark:text-stone-400">Global Promotions</div>
          </div>
        </div>
      </div>

      {/* Overall Trend */}
      {overallTrend && runDiffs.length > 1 && (
        <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
          <h4 className="text-xs font-semibold text-stone-600 dark:text-stone-400 mb-2">Overall Trend ({totalRuns} runs)</h4>
          <div className="flex items-center gap-6">
            <div>
              <span className="text-xs text-stone-500 dark:text-stone-400">Confidence: </span>
              <span className={`text-sm font-medium ${trendColor(overallTrend.confidenceTrend)}`}>
                {overallTrend.confidenceTrend} {trendArrow(overallTrend.confidenceTrend)}
              </span>
            </div>
            <div>
              <span className="text-xs text-stone-500 dark:text-stone-400">Efficiency: </span>
              <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
                {overallTrend.learningEfficiency.toFixed(3)}/run
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  delta,
  format,
  lowerIsBetter = false,
}: {
  label: string;
  delta: number;
  format: (v: number) => string;
  lowerIsBetter?: boolean;
}) {
  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3 text-center">
      <div className={`text-sm font-bold ${deltaColor(delta, lowerIsBetter)}`}>
        {format(delta)}
      </div>
      <div className="text-xs text-stone-500 dark:text-stone-400">{label}</div>
    </div>
  );
}
