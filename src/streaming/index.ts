/**
 * Streaming pipeline — connects LLM providers to TUI with tool calls.
 */

// Types
export type {
  StreamEvent,
  AgentStartEvent,
  TokenEvent,
  ToolCallStartEvent,
  ToolCallProgressEvent,
  ToolCallDoneEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  TokenUpdateEvent,
  StreamCompleteEvent,
  AgentRunResult,
  ToolCallRecord,
  LLMMessage,
  LLMToolCall,
  StreamError,
  TokenSummary,
} from "./types.js";

// Context
export { ContextBuilder } from "./context-builder.js";
export type { BuiltContext } from "./context-builder.js";

// Tool call handling
export { ToolCallHandler } from "./tool-call-handler.js";
export type { ToolCallResult } from "./tool-call-handler.js";

// Agent runner
export { AgentRunner } from "./agent-runner.js";
export type { LLMStreamProvider } from "./agent-runner.js";

// Orchestrator
export { StreamOrchestrator } from "./stream-orchestrator.js";

// Token tracking
export { TokenTracker } from "./cost-tracker.js";

// Abort management
export { StreamAbortManager } from "./abort-controller.js";
