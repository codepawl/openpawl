/**
 * Error recovery & graceful degradation.
 */

export type {
  RecoveryStrategy,
  RetryStrategy,
  FallbackStrategy,
  DegradeStrategy,
  CompressStrategy,
  AbortStrategy,
  ReportStrategy,
  RecoverableError,
  ErrorCategory,
  CircuitBreakerState,
  ErrorContext,
} from "./types.js";

export { ErrorPresenter } from "./error-presenter.js";
export { RetryEngine, CircuitBreaker } from "./retry-engine.js";
export { AgentWatchdog } from "./agent-watchdog.js";
export type { WatchdogHandle, StopReason } from "./agent-watchdog.js";
export { CrashHandler } from "./crash-handler.js";
export { RecoveryOrchestrator } from "./recovery-orchestrator.js";
