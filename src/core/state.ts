/**
 * Work session state for TeamClaw.
 * Central state passed between all LangGraph nodes.
 */

import { z } from "zod";

export const TaskRequestSchema = z.object({
  task_id: z.string(),
  description: z.string(),
  priority: z.string().default("MEDIUM"),
  estimated_cost: z.number().default(0),
});
export type TaskRequest = z.infer<typeof TaskRequestSchema>;

export const TaskResultSchema = z.object({
  task_id: z.string(),
  success: z.boolean(),
  output: z.string(),
  quality_score: z.number().default(0.5),
  confidence: z.object({
    score: z.number(),
    reasoning: z.string(),
    flags: z.array(z.string()),
  }).optional(),
  routing_decision: z.enum(["auto_approved", "qa_review", "rework", "escalated"]).optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const WorkerTierSchema = z.enum(["light", "heavy"]);
export type WorkerTier = z.infer<typeof WorkerTierSchema>;

export const TaskQueueItemSchema = z.object({
  task_id: z.string(),
  assigned_to: z.string(),
  status: z
    .enum(["pending", "in_progress", "reviewing", "needs_rework", "completed", "failed", "TIMEOUT_WARNING"])
    .default("pending"),
  description: z.string(),
  priority: z.string().default("MEDIUM"),
  worker_tier: WorkerTierSchema.default("light"),
  result: z.record(z.unknown()).nullable().default(null),
  urgency: z.number().min(1).max(10).default(5),
  importance: z.number().min(1).max(10).default(5),
  timebox_minutes: z.number().min(1).default(25),
  in_progress_at: z.string().nullable().default(null),
  retry_count: z.number().min(0).default(0),
  max_retries: z.number().min(1).default(2),
  reviewer_feedback: z.string().nullable().default(null),
  original_maker: z.string().nullable().default(null),
  dependencies: z.array(z.string()).default([]),
});
export type TaskQueueItem = z.infer<typeof TaskQueueItemSchema>;

export const AgentMessageSchema = z.object({
  from_bot: z.string(),
  to_bot: z.string(),
  content: z.string(),
  timestamp: z.string().nullable().default(null),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export type GameState = {
  cycle_count: number;
  session_active: boolean;
  last_action: string;
  messages: string[];
  last_quality_score: number;
  death_reason: string | null;
  generation_id: number;
  ancestral_lessons: string[];
  team: Record<string, unknown>[];
  agent_messages: Record<string, unknown>[];
  user_goal: string | null;
  task_queue: Record<string, unknown>[];
  bot_stats: Record<string, Record<string, unknown>>;
};

export function initializeGameState(
  generationId = 1,
  ancestralLessons: string[] = []
): GameState {
  const lessons = ancestralLessons ?? [];
  return {
    cycle_count: 0,
    session_active: true,
    last_action: "Work session started",
    messages: [`TeamClaw - Run ${generationId} started`],
    last_quality_score: 0,
    death_reason: null,
    generation_id: generationId,
    ancestral_lessons: lessons,
    team: [],
    agent_messages: [],
    user_goal: null,
    task_queue: [],
    bot_stats: {},
  };
}

export function initializeTeamState(
  team: Record<string, unknown>[],
  userGoal: string | null = null
): Partial<GameState> {
  const botStats: Record<string, Record<string, unknown>> = {};
  for (const bot of team) {
    const bid = (bot?.id as string) ?? "unknown";
    botStats[bid] = {
      tasks_completed: 0,
      tasks_failed: 0,
    };
  }
  return {
    team,
    agent_messages: [],
    user_goal: userGoal,
    task_queue: [],
    bot_stats: botStats,
  };
}
