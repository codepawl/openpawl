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
  agent_messages: Annotation<Record<string, unknown>[]>(
    lastValue<Record<string, unknown>[]>(() => [])
  ),
  user_goal: Annotation<string | null>(lastValue<string | null>(() => null)),
  project_context: Annotation<string>(lastValue<string>(() => "")),
  task_queue: Annotation<Record<string, unknown>[]>(
    lastValue<Record<string, unknown>[]>(() => [])
  ),
  bot_stats: Annotation<Record<string, Record<string, unknown>>>(
    lastValue<Record<string, Record<string, unknown>>>(() => ({}))
  ),
  approval_pending: Annotation<Record<string, unknown> | null>(
    lastValue<Record<string, unknown> | null>(() => null)
  ),
  approval_response: Annotation<Record<string, unknown> | null>(
    lastValue<Record<string, unknown> | null>(() => null)
  ),
  __node__: Annotation<string | null>(lastValue<string | null>(() => null)),
});

export type GraphState = typeof GameStateAnnotation.State;
