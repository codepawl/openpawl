/**
 * Streaming pipeline types — events, results, messages, errors.
 */

// ─── Stream Events (pipeline → TUI) ─────────────────────────────────────────

export type StreamEvent =
  | AgentStartEvent
  | TokenEvent
  | ToolCallStartEvent
  | ToolCallProgressEvent
  | ToolCallDoneEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | TokenUpdateEvent
  | StreamCompleteEvent;

export interface AgentStartEvent {
  type: "agent:start";
  sessionId: string;
  agentId: string;
  agentName: string;
  task: string;
  timestamp: number;
}

export interface TokenEvent {
  type: "agent:token";
  sessionId: string;
  agentId: string;
  token: string;
  timestamp: number;
}

export interface ToolCallStartEvent {
  type: "tool:start";
  sessionId: string;
  agentId: string;
  executionId: string;
  toolName: string;
  toolDisplayName: string;
  inputSummary: string;
  timestamp: number;
}

export interface ToolCallProgressEvent {
  type: "tool:progress";
  sessionId: string;
  agentId: string;
  executionId: string;
  message: string;
  timestamp: number;
}

export interface ToolCallDoneEvent {
  type: "tool:done";
  sessionId: string;
  agentId: string;
  executionId: string;
  toolName: string;
  success: boolean;
  outputSummary: string;
  fullOutput?: string;
  duration: number;
  timestamp: number;
}

export interface AgentDoneEvent {
  type: "agent:done";
  sessionId: string;
  agentId: string;
  finalContent: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  duration: number;
  timestamp: number;
}

export interface AgentErrorEvent {
  type: "agent:error";
  sessionId: string;
  agentId: string;
  error: string;
  recoverable: boolean;
  timestamp: number;
}

export interface TokenUpdateEvent {
  type: "tokens:update";
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  timestamp: number;
}

export interface StreamCompleteEvent {
  type: "stream:complete";
  sessionId: string;
  agentResults: AgentRunResult[];
  totalDuration: number;
  timestamp: number;
}

// ─── Agent Run Result ────────────────────────────────────────────────────────

export interface AgentRunResult {
  agentId: string;
  success: boolean;
  content: string;
  toolCalls: ToolCallRecord[];
  inputTokens: number;
  outputTokens: number;
  duration: number;
  error?: string;
}

export interface ToolCallRecord {
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  duration: number;
}

// ─── LLM Messages ───────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type StreamError =
  | { type: "provider_error"; provider: string; cause: string }
  | { type: "context_too_large"; estimatedTokens: number; maxTokens: number }
  | { type: "tool_loop_limit"; agentId: string; iterations: number }
  | { type: "agent_timeout"; agentId: string; timeoutMs: number }
  | { type: "aborted"; sessionId: string; agentId?: string }
  | { type: "all_agents_failed"; errors: Array<{ agentId: string; error: string }> }
  | { type: "no_provider_available"; message: string }
  | { type: "serialization_error"; cause: string };

// ─── Token Summary ──────────────────────────────────────────────────────────

export interface TokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<string, { tokens: number }>;
  byAgent: Record<string, { tokens: number }>;
}
