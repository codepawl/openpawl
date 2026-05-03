/**
 * Type definitions for the prompt router and agent dispatcher.
 */

// ─── Intent Classification ───────────────────────────────────────────────────

export type IntentCategory =
  | "code_write"
  | "code_edit"
  | "code_review"
  | "code_debug"
  | "code_explain"
  | "test_write"
  | "test_run"
  | "plan"
  | "research"
  | "file_ops"
  | "git_ops"
  | "shell"
  | "conversation"
  | "multi_step"
  | "config"
  | "unknown";

export interface PromptIntent {
  category: IntentCategory;
  confidence: number;
  complexity: "trivial" | "simple" | "moderate" | "complex";
  requiresTools: string[];
  suggestedAgents: string[];
  reasoning: string;
}

// ─── Routing Decision ────────────────────────────────────────────────────────

export type DispatchStrategy =
  | "single"
  | "sequential"
  | "parallel"
  | "orchestrated"
  | "clarify";

export interface AgentAssignment {
  agentId: string;
  role: string;
  task: string;
  tools: string[];
  model?: string;
  priority: number;
  dependsOn?: string[];
}

export interface RouteDecision {
  strategy: DispatchStrategy;
  agents: AgentAssignment[];
  plan?: string;
  estimatedCost?: number;
  requiresConfirmation: boolean;
}

// ─── Agent Registry ──────────────────────────────────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  defaultTools: string[];
  modelTier: "primary" | "fast" | "mini";
  systemPrompt: string;
  personality?: string;
  triggerPatterns?: string[];
  canCollaborate: boolean;
  maxConcurrent: number;
}

// ─── Mention Parsing ─────────────────────────────────────────────────────────

export interface AgentMention {
  agentId: string;
  raw: string;
  position: number;
  task?: string;
}

export interface MentionParseResult {
  mentions: AgentMention[];
  cleanedPrompt: string;
  hasExplicitRouting: boolean;
}

// ─── Dispatch Results ────────────────────────────────────────────────────────

export interface ToolCallSummary {
  tool: string;
  input: string;
  output: string;
  duration: number;
  success: boolean;
  /** Shell exit code for shell_exec (and tools that wrap it). */
  exitCode?: number;
  /** First ~200 chars of stderr for shell_exec. */
  stderrHead?: string;
}

export interface AgentResult {
  agentId: string;
  success: boolean;
  response: string;
  toolCalls: ToolCallSummary[];
  duration: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface DispatchResult {
  strategy: DispatchStrategy;
  agentResults: AgentResult[];
  totalDuration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type RouterError =
  | { type: "no_agents_available"; message: string }
  | { type: "agent_not_found"; agentId: string }
  | { type: "classification_failed"; cause: string }
  | { type: "dispatch_failed"; agentId: string; cause: string }
  | { type: "all_agents_failed"; results: Array<{ agentId: string; error: string }> }
  | { type: "session_not_found"; sessionId: string }
  | { type: "confirmation_rejected"; message: string };
