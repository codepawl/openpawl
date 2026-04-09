/**
 * Streaming types — kept for tool-call-handler.ts.
 */

export type StreamEvent =
  | { type: "agent:start"; sessionId: string; agentId: string; agentName: string; task: string; timestamp: number }
  | { type: "agent:token"; sessionId: string; agentId: string; token: string; timestamp: number }
  | { type: "tool:start"; sessionId: string; agentId: string; executionId: string; toolName: string; toolDisplayName: string; inputSummary: string; timestamp: number }
  | { type: "tool:progress"; sessionId: string; agentId: string; executionId: string; message: string; timestamp: number }
  | { type: "tool:done"; sessionId: string; agentId: string; executionId: string; toolName: string; success: boolean; outputSummary: string; fullOutput?: string; duration: number; timestamp: number }
  | { type: "agent:done"; sessionId: string; agentId: string; finalContent: string; toolCallCount: number; inputTokens: number; outputTokens: number; duration: number; timestamp: number }
  | { type: "agent:error"; sessionId: string; agentId: string; error: string; recoverable: boolean; timestamp: number }
  | { type: "tokens:update"; sessionId: string; totalInputTokens: number; totalOutputTokens: number; timestamp: number }
  | { type: "stream:complete"; sessionId: string; agentResults: AgentRunResult[]; totalDuration: number; timestamp: number };

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

export type StreamError =
  | { type: "provider_error"; provider: string; cause: string }
  | { type: "context_too_large"; estimatedTokens: number; maxTokens: number }
  | { type: "tool_loop_limit"; agentId: string; iterations: number }
  | { type: "agent_timeout"; agentId: string; timeoutMs: number }
  | { type: "aborted"; sessionId: string; agentId?: string }
  | { type: "all_agents_failed"; errors: Array<{ agentId: string; error: string }> }
  | { type: "no_provider_available"; message: string }
  | { type: "serialization_error"; cause: string };
