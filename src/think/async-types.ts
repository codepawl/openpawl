/**
 * Types for async thinking — background think jobs.
 */

import type { ThinkSession } from "./types.js";

export type AsyncThinkStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AsyncThinkJob {
  id: string;
  question: string;
  status: AsyncThinkStatus;
  pid: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  result: ThinkSession | null;
  notificationSent: boolean;
  briefedAt: number | null;
  autoSave: boolean;
}

export interface AsyncThinkSummary {
  jobId: string;
  question: string;
  status: AsyncThinkStatus;
  recommendation: string | null;
  confidence: number | null;
  completedAt: number | null;
  savedToJournal: boolean;
}

export const MAX_CONCURRENT_ASYNC_JOBS = 3;
