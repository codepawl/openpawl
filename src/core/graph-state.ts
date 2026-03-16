/**
 * LangGraph state annotation for work session state.
 * Defines the shape and reducers for the orchestration graph.
 */

import { Annotation } from "@langchain/langgraph";

function lastValue<T>(defaultFn: () => T): { reducer: (left: T, right: T) => T; default: () => T } {
  return { reducer: (_left, right) => right, default: defaultFn };
}

export const GameStateAnnotation = Annotation.Root({
  cycle_count: Annotation<number>(lastValue(() => 0)),
  session_active: Annotation<boolean>(lastValue(() => true)),
  last_action: Annotation<string>(lastValue(() => "")),
  messages: Annotation<string[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  last_quality_score: Annotation<number>(lastValue(() => 0)),
  death_reason: Annotation<string | null>(lastValue<string | null>(() => null)),
  generation_id: Annotation<number>(lastValue(() => 1)),
  ancestral_lessons: Annotation<string[]>(lastValue<string[]>(() => [])),
  team: Annotation<Record<string, unknown>[]>(lastValue<Record<string, unknown>[]>(() => [])),
  agent_messages: Annotation<Record<string, unknown>[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  user_goal: Annotation<string | null>(lastValue<string | null>(() => null)),
  project_context: Annotation<string>(lastValue<string>(() => "")),
  task_queue: Annotation<Record<string, unknown>[]>({
    reducer: (left, right) => {
      const map = new Map<string, Record<string, unknown>>();
      for (const item of left) { const id = item.task_id as string; if (id) map.set(id, item); }
      for (const item of right) { const id = item.task_id as string; if (id) map.set(id, item); }
      return Array.from(map.values());
    },
    default: () => [],
  }),
  bot_stats: Annotation<Record<string, Record<string, unknown>>>({
    reducer: (left, right) => {
      const merged = { ...left };
      for (const [botId, stats] of Object.entries(right)) {
        if (!merged[botId]) { merged[botId] = stats; continue; }
        const existing = merged[botId];
        merged[botId] = { ...existing };
        for (const [key, val] of Object.entries(stats)) {
          if (typeof val === "number" && typeof existing[key] === "number") {
            merged[botId][key] = (existing[key] as number) + (val as number);
          } else {
            merged[botId][key] = val;
          }
        }
      }
      return merged;
    },
    default: () => ({}),
  }),
  approval_pending: Annotation<Record<string, unknown> | null>(
    lastValue<Record<string, unknown> | null>(() => null)
  ),
  approval_response: Annotation<Record<string, unknown> | null>(
    lastValue<Record<string, unknown> | null>(() => null)
  ),
  __node__: Annotation<string | null>(lastValue<string | null>(() => null)),
  
  planning_document: Annotation<string | null>(lastValue<string | null>(() => null)),
  architecture_document: Annotation<string | null>(lastValue<string | null>(() => null)),
  rfc_document: Annotation<string | null>(lastValue<string | null>(() => null)),
  deep_work_mode: Annotation<boolean>(lastValue(() => false)),
  last_pulse_timestamp: Annotation<number>(lastValue(() => 0)),
  pulse_interval_ms: Annotation<number>(lastValue(() => 30_000)),
  
  mid_sprint_reported: Annotation<boolean>(lastValue(() => false)),
  total_tasks: Annotation<number>(lastValue(() => 0)),
  completed_tasks: Annotation<number>(lastValue(() => 0)),
  parallelism_depth: Annotation<number>(lastValue(() => 0)),

  retrieved_memories: Annotation<string>(lastValue(() => "")),
  preferences_context: Annotation<string>(lastValue(() => "")),

  // Preview gate — approval step before fan-out execution
  preview: Annotation<Record<string, unknown> | null>(lastValue<Record<string, unknown> | null>(() => null)),
  aborted: Annotation<boolean>(lastValue(() => false)),
  skip_preview: Annotation<boolean>(lastValue(() => false)),

  // Confidence scoring
  average_confidence: Annotation<number>(lastValue(() => 0)),
  low_confidence_tasks: Annotation<string[]>(lastValue<string[]>(() => [])),
  confidence_history: Annotation<Record<string, unknown>[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),

  // Partial approval — escalated tasks deferred to next sprint
  next_sprint_backlog: Annotation<Record<string, unknown>[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  approval_stats: Annotation<Record<string, unknown>>(lastValue<Record<string, unknown>>(() => ({}))),

  // Send-payload fields: transient, set by Send() args during parallel worker superstep
  _send_task: Annotation<Record<string, unknown> | null>(lastValue<Record<string, unknown> | null>(() => null)),
  _send_bot_id: Annotation<string>(lastValue(() => "")),
});

export type GraphState = typeof GameStateAnnotation.State;
