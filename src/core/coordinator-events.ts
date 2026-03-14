/**
 * Coordinator progress events — emitted mid-node so the dashboard
 * can show step-by-step status instead of silence during the LLM call.
 */

import { EventEmitter } from "node:events";

export interface CoordinatorStep {
  step: string;
  detail: string;
  timestamp: number;
}

export const coordinatorEvents = new EventEmitter();
