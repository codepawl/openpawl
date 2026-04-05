/**
 * Error recovery types — strategies, categories, circuit breaker.
 */

export type RecoveryStrategy =
  | RetryStrategy
  | FallbackStrategy
  | DegradeStrategy
  | CompressStrategy
  | AbortStrategy
  | ReportStrategy;

export interface RetryStrategy {
  type: "retry";
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  jitter: boolean;
}

export interface FallbackStrategy {
  type: "fallback";
  fallbackAction: string;
}

export interface DegradeStrategy {
  type: "degrade";
  degradedMode: string;
}

export interface CompressStrategy {
  type: "compress";
  targetReduction: number;
}

export interface AbortStrategy {
  type: "abort";
  reason: string;
  saveState: boolean;
}

export interface ReportStrategy {
  type: "report";
  message: string;
  severity: "info" | "warning" | "error";
  actionHint?: string;
}

export interface RecoverableError {
  original: unknown;
  category: ErrorCategory;
  strategy: RecoveryStrategy;
  userMessage: string;
  actionHint: string;
  recoverable: boolean;
  timestamp: number;
}

export type ErrorCategory =
  | "network"
  | "auth"
  | "rate_limit"
  | "model"
  | "context"
  | "tool"
  | "agent"
  | "session"
  | "config"
  | "system"
  | "unknown";

export interface CircuitBreakerState {
  provider: string;
  state: "closed" | "open" | "half-open";
  failureCount: number;
  lastFailureAt: number;
  openUntil: number;
}

export interface ErrorContext {
  sessionId?: string;
  agentId?: string;
  toolName?: string;
  provider?: string;
  operation?: string;
}
