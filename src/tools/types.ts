/**
 * Tool system type definitions.
 */

import type { z } from "zod";
import type { Result } from "neverthrow";

// ─── Tool Definition ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  displayName: string;
  description: string;
  category: ToolCategory;
  inputSchema: z.ZodType<unknown>;
  outputSchema?: z.ZodType<unknown>;
  defaultPermission: PermissionLevel;
  riskLevel: RiskLevel;
  destructive: boolean;
  requiresNetwork: boolean;
  execute: ToolExecuteFn;
  validate?: (input: unknown) => Result<void, ToolError>;
  source: ToolSource;
  version?: string;
  documentation?: string;
}

export type ToolCategory = "file" | "shell" | "code" | "git" | "web" | "mcp" | "custom";
export type PermissionLevel = "auto" | "confirm" | "session" | "block";
export type RiskLevel = "safe" | "moderate" | "dangerous" | "destructive";
export type ToolSource = "built-in" | "mcp" | "plugin" | "custom";

// ─── Execution ───────────────────────────────────────────────────────────────

export type ToolExecuteFn = (
  input: unknown,
  context: ToolExecutionContext,
) => Promise<Result<ToolOutput, ToolError>>;

export interface ToolExecutionContext {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ToolOutput {
  success: boolean;
  data: unknown;
  summary: string;
  fullOutput?: string;
  filesModified?: string[];
  duration: number;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type ToolError =
  | { type: "not_found"; toolName: string }
  | { type: "permission_denied"; toolName: string; level: PermissionLevel }
  | { type: "validation_failed"; toolName: string; errors: string[] }
  | { type: "execution_failed"; toolName: string; cause: string }
  | { type: "timeout"; toolName: string; timeoutMs: number }
  | { type: "aborted"; toolName: string }
  | { type: "sandbox_error"; toolName: string; cause: string }
  | { type: "mcp_error"; toolName: string; server: string; cause: string };

// ─── Permission Config ───────────────────────────────────────────────────────

export interface ToolPermissionConfig {
  defaults?: Partial<Record<string, PermissionLevel>>;
  agents?: Record<string, {
    allow?: string[];
    block?: string[];
    permissions?: Record<string, PermissionLevel>;
  }>;
  tools?: Record<string, {
    permission?: PermissionLevel;
    allowedPaths?: string[];
    blockedCommands?: string[];
  }>;
  mcp?: Array<{
    name: string;
    url: string;
    permission?: PermissionLevel;
  }>;
}

// ─── Resolved Tool Set ───────────────────────────────────────────────────────

export interface ResolvedToolSet {
  tools: Map<string, ToolDefinition>;
  permissions: Map<string, PermissionLevel>;
  blocked: string[];
}

// ─── LLM Schema Export ───────────────────────────────────────────────────────

export interface LLMToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Permission Check ────────────────────────────────────────────────────────

export type PermissionCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "blocked" }
  | { needsConfirmation: true; risk: RiskLevel; description: string };
