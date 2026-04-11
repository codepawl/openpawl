/**
 * Translate errors into user-facing messages.
 * Every message: what happened + what to do.
 */

import type { RecoverableError, ErrorCategory, RecoveryStrategy, ErrorContext } from "./types.js";
import { ICONS } from "../tui/constants/icons.js";

export class ErrorPresenter {
  present(error: unknown, context?: ErrorContext): RecoverableError {
    const category = classifyError(error);
    const { userMessage, actionHint, strategy, recoverable } = getErrorDetails(error, category, context);

    return {
      original: error,
      category,
      strategy,
      userMessage,
      actionHint,
      recoverable,
      timestamp: Date.now(),
    };
  }

  formatForChat(error: RecoverableError): string[] {
    const icon = error.recoverable ? ICONS.warning : ICONS.error;
    const lines = [`  ${icon} ${error.userMessage}`];
    if (error.actionHint) lines.push(`    ${error.actionHint}`);
    return lines;
  }

  formatForStatusBar(error: RecoverableError): string {
    return `⚠ ${error.userMessage.slice(0, 40)}`;
  }

  formatForLog(error: RecoverableError): string {
    const stack = error.original instanceof Error ? error.original.stack : String(error.original);
    return `[${new Date(error.timestamp).toISOString()}] ${error.category}: ${error.userMessage}\n${stack}`;
  }
}

function classifyError(error: unknown): ErrorCategory {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as Record<string, unknown>;

  // Check for typed errors
  if (e.type === "rate_limit" || e.code === "rate_limit") return "rate_limit";
  if (e.type === "timeout" || e.code === "ETIMEDOUT" || e.code === "ECONNABORTED") return "network";
  if (e.type === "auth_failed" || e.code === "401" || e.code === "EAUTH") return "auth";
  if (e.type === "model_not_found") return "model";
  if (e.type === "context_too_long" || e.type === "context_too_large") return "context";
  if (e.type === "execution_failed" || e.type === "permission_denied" || e.type === "sandbox_error") return "tool";
  if (e.type === "not_found" && e.id) return "session";
  if (e.type === "invalid_config" || e.type === "missing_provider") return "config";

  // Network errors
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "ENETUNREACH") return "network";

  // Error message heuristics
  const msg = (e.message as string ?? "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("429")) return "rate_limit";
  if (msg.includes("timeout") || msg.includes("timed out")) return "network";
  if (msg.includes("unauthorized") || msg.includes("401") || msg.includes("api key")) return "auth";

  return "unknown";
}

function getErrorDetails(
  error: unknown,
  category: ErrorCategory,
  context?: ErrorContext,
): { userMessage: string; actionHint: string; strategy: RecoveryStrategy; recoverable: boolean } {
  const provider = context?.provider ?? "provider";

  switch (category) {
    case "network":
      return {
        userMessage: `Connection to ${provider} timed out.`,
        actionHint: "Retrying automatically...",
        strategy: { type: "retry", maxAttempts: 3, backoffMs: 2000, maxBackoffMs: 30000, jitter: true },
        recoverable: true,
      };
    case "auth":
      return {
        userMessage: `API key for ${provider} was rejected.`,
        actionHint: `Run: openpawl auth set ${provider}`,
        strategy: { type: "abort", reason: "Auth failed", saveState: true },
        recoverable: false,
      };
    case "rate_limit":
      return {
        userMessage: `${provider} rate limit reached.`,
        actionHint: "Switching to fallback provider...",
        strategy: { type: "retry", maxAttempts: 3, backoffMs: 5000, maxBackoffMs: 60000, jitter: true },
        recoverable: true,
      };
    case "model":
      return {
        userMessage: "Model not available.",
        actionHint: "Run: /model list — or switch model: /model <name>",
        strategy: { type: "abort", reason: "Model not found", saveState: true },
        recoverable: false,
      };
    case "context":
      return {
        userMessage: "Conversation too long for current model.",
        actionHint: "Compressing history and retrying...",
        strategy: { type: "compress", targetReduction: 50 },
        recoverable: true,
      };
    case "tool":
      return {
        userMessage: `Tool '${context?.toolName ?? "unknown"}' failed.`,
        actionHint: "The agent will try a different approach.",
        strategy: { type: "report", message: "Tool failure", severity: "warning" },
        recoverable: true,
      };
    case "agent":
      return {
        userMessage: `Agent '${context?.agentId ?? "unknown"}' encountered an issue.`,
        actionHint: "Try rephrasing your request.",
        strategy: { type: "report", message: "Agent issue", severity: "warning" },
        recoverable: true,
      };
    case "session":
      return {
        userMessage: "Session data issue.",
        actionHint: "Recovering from last checkpoint...",
        strategy: { type: "fallback", fallbackAction: "Recover from checkpoint" },
        recoverable: true,
      };
    case "config":
      return {
        userMessage: "Configuration error.",
        actionHint: "Run: openpawl check — or fix ~/.openpawl/config.json",
        strategy: { type: "abort", reason: "Config invalid", saveState: false },
        recoverable: false,
      };
    default:
      return {
        userMessage: "An unexpected error occurred.",
        actionHint: "Your session is saved. Restart OpenPawl to continue.",
        strategy: { type: "abort", reason: "Unknown error", saveState: true },
        recoverable: false,
      };
  }
}
