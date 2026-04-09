/**
 * Heatmap data builder — constructs grid data from utilization metrics.
 */

import type {
  AgentUtilization,
  HeatmapData,
  HeatmapRow,
  HeatmapColumn,
  HeatmapCell,
  HeatmapMetric,
  HeatmapScope,
  HeatmapViewType,
  BottleneckAlert,
} from "./types.js";

const DEFAULT_BOTTLENECK_THRESHOLD = 0.8;
const DEFAULT_TIME_BUCKETS = 10;

export interface BuilderOptions {
  metric?: HeatmapMetric;
  viewType?: HeatmapViewType;
  bottleneckThreshold?: number;
  timeBuckets?: number;
}

/** Build a heatmap grid from agent utilization data. */
export function buildHeatmap(
  utilizations: AgentUtilization[],
  scope: HeatmapScope,
  options: BuilderOptions = {},
): HeatmapData {
  const metric = options.metric ?? "duration";
  const viewType = options.viewType ?? "task";
  const threshold = options.bottleneckThreshold ?? DEFAULT_BOTTLENECK_THRESHOLD;

  if (utilizations.length === 0) {
    return {
      sessionId: "",
      scope,
      rows: [],
      columns: [],
      cells: [],
      bottlenecks: [],
      suggestions: [],
    };
  }

  const sessionId = utilizations[0].sessionId;
  const runIndex = utilizations[0].runIndex;

  // Build rows — one per agent
  const rows: HeatmapRow[] = utilizations.map((u) => ({
    agentRole: u.agentRole,
    displayName: formatAgentName(u.agentRole),
    overallUtilization: u.utilizationPct,
    isBottleneck: u.utilizationPct >= threshold || u.queueDepth > 2,
  }));

  // Build columns based on view type
  let columns: HeatmapColumn[];
  let cells: HeatmapCell[][];

  if (viewType === "task") {
    // One column per task type found across all agents
    const allTaskTypes = new Set<string>();
    for (const u of utilizations) {
      for (const tb of u.taskTypeBreakdown) {
        allTaskTypes.add(tb.taskType);
      }
    }
    const taskTypes = Array.from(allTaskTypes).sort();

    columns = [
      ...taskTypes.map((t) => ({ id: t, label: t, type: "task" as HeatmapViewType })),
      { id: "avg", label: "Avg", type: "task" as HeatmapViewType },
    ];

    cells = rows.map((row) => {
      const u = utilizations.find((x) => x.agentRole === row.agentRole)!;
      const rowCells: HeatmapCell[] = taskTypes.map((tt) => {
        const breakdown = u.taskTypeBreakdown.find((b) => b.taskType === tt);
        return buildCell(row.agentRole, tt, breakdown, metric, u);
      });
      // Avg column
      rowCells.push({
        agentRole: row.agentRole,
        columnId: "avg",
        value: u.utilizationPct,
        displayValue: `${Math.round(u.utilizationPct * 100)}%`,
        metric,
      });
      return rowCells;
    });
  } else if (viewType === "time_bucket") {
    const buckets = options.timeBuckets ?? DEFAULT_TIME_BUCKETS;
    columns = Array.from({ length: buckets }, (_, i) => ({
      id: `bucket-${i}`,
      label: `${Math.round((i / buckets) * 100)}-${Math.round(((i + 1) / buckets) * 100)}%`,
      type: "time_bucket" as HeatmapViewType,
    }));

    // For time buckets, distribute utilization evenly (simplified)
    cells = rows.map((row) => {
      const u = utilizations.find((x) => x.agentRole === row.agentRole)!;
      return columns.map((col) => ({
        agentRole: row.agentRole,
        columnId: col.id,
        value: u.utilizationPct, // Simplified — real implementation would use event timestamps
        displayValue: u.utilizationPct > 0.5 ? "████" : u.utilizationPct > 0.2 ? "██░░" : "░░░░",
        metric,
      }));
    });
  } else {
    // Run view — one column per run
    const runIndices = [...new Set(utilizations.map((u) => u.runIndex))].sort((a, b) => a - b);
    columns = runIndices.map((r) => ({
      id: `run-${r}`,
      label: `Run ${r}`,
      type: "run" as HeatmapViewType,
    }));

    const agentRoles = [...new Set(utilizations.map((u) => u.agentRole))];
    cells = agentRoles.map((role) => {
      return columns.map((col) => {
        const runIdx = parseInt(col.id.replace("run-", ""), 10);
        const u = utilizations.find((x) => x.agentRole === role && x.runIndex === runIdx);
        if (!u) {
          return { agentRole: role, columnId: col.id, value: 0, displayValue: "—", metric };
        }
        return buildCellFromUtilization(role, col.id, u, metric);
      });
    });
  }

  // Detect bottlenecks
  const bottlenecks: BottleneckAlert[] = utilizations
    .filter((u) => u.utilizationPct >= threshold || u.queueDepth > 2)
    .map((u) => ({
      agentRole: u.agentRole,
      utilizationPct: u.utilizationPct,
      queueDepth: u.queueDepth,
      impactedTasks: u.taskTypeBreakdown.map((t) => t.taskType),
      estimatedDelayMs: u.queueDepth > 1
        ? u.averageDurationMs * (u.queueDepth - 1)
        : 0,
    }));

  return {
    sessionId,
    runIndex: scope === "run" ? runIndex : undefined,
    scope,
    rows,
    columns,
    cells,
    bottlenecks,
    suggestions: [], // Filled by suggestions module
  };
}

function buildCell(
  agentRole: string,
  columnId: string,
  breakdown: { count: number; avgDurationMs: number; avgConfidence: number } | undefined,
  metric: HeatmapMetric,
  utilization: AgentUtilization,
): HeatmapCell {
  if (!breakdown || breakdown.count === 0) {
    return { agentRole, columnId, value: 0, displayValue: "—", metric };
  }

  let value: number;
  let displayValue: string;

  switch (metric) {
    case "duration":
      value = Math.min(breakdown.avgDurationMs / (utilization.maxDurationMs || 1), 1);
      displayValue = formatDuration(breakdown.avgDurationMs);
      break;
    case "cost": {
      value = 0;
      displayValue = "—";
      break;
    }
    case "confidence":
      value = breakdown.avgConfidence;
      displayValue = breakdown.avgConfidence.toFixed(2);
      break;
    default:
      value = 0;
      displayValue = "—";
  }

  return { agentRole, columnId, value: Math.round(value * 100) / 100, displayValue, metric };
}

function buildCellFromUtilization(
  agentRole: string,
  columnId: string,
  u: AgentUtilization,
  metric: HeatmapMetric,
): HeatmapCell {
  switch (metric) {
    case "duration":
      return { agentRole, columnId, value: u.utilizationPct, displayValue: formatDuration(u.averageDurationMs), metric };
    case "cost":
      return { agentRole, columnId, value: 0, displayValue: "—", metric };
    case "confidence":
      return { agentRole, columnId, value: u.averageConfidence, displayValue: u.averageConfidence.toFixed(2), metric };
    default:
      return { agentRole, columnId, value: 0, displayValue: "—", metric };
  }
}

function formatAgentName(nodeId: string): string {
  return nodeId
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m${s.toString().padStart(2, "0")}s`;
}
