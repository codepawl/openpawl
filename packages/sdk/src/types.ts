/**
 * Types for the TeamClaw Custom Agent SDK.
 */

/** Context passed to agent hooks during task execution. */
export interface AgentContext {
  sessionId: string;
  taskId: string;
  runIndex: number;
  proxyUrl: string;
  config: Record<string, unknown>;
}

/** Confidence scoring configuration for a custom agent. */
export interface ConfidenceConfig {
  /** Minimum confidence threshold (0-1). Tasks below this trigger rework. */
  minConfidence?: number;
  /** Custom confidence flags this agent can emit. */
  flags?: string[];
}

/** Composition rules controlling when this agent is auto-included. */
export interface CompositionRules {
  /** Keywords in the goal that trigger inclusion. */
  includeKeywords?: string[];
  /** Keywords in the goal that suppress inclusion. */
  excludeKeywords?: string[];
  /** Minimum goal complexity score to include this agent. */
  minComplexityScore?: number;
  /** If true, agent is always included regardless of keywords. */
  required?: boolean;
}

/** Lifecycle hooks for custom agents. */
export interface AgentHooks {
  /** Called before the agent processes a task. Can transform the task. */
  beforeTask?: (task: Record<string, unknown>, context: AgentContext) => Promise<Record<string, unknown>>;
  /** Called after task completion. Can transform the result. */
  afterTask?: (result: Record<string, unknown>, context: AgentContext) => Promise<Record<string, unknown>>;
  /** Called when the agent encounters an error. */
  onError?: (error: Error, context: AgentContext) => Promise<void>;
}

/** Full definition for a custom agent. */
export interface AgentDefinition {
  /** Unique kebab-case identifier (e.g. "code-reviewer"). */
  role: string;
  /** Human-readable name (e.g. "Code Reviewer"). */
  displayName: string;
  /** What this agent does. */
  description: string;
  /** Task types this agent can handle (e.g. ["review", "audit"]). */
  taskTypes: string[];
  /** System prompt used when the agent processes tasks. */
  systemPrompt: string;
  /** Confidence scoring configuration. */
  confidenceConfig?: ConfidenceConfig;
  /** Rules for autonomous composition. */
  compositionRules?: CompositionRules;
  /** Lifecycle hooks. */
  hooks?: AgentHooks;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Branded agent definition returned by defineAgent(). */
export interface ValidatedAgentDefinition extends AgentDefinition {
  readonly __teamclaw_agent: true;
}
