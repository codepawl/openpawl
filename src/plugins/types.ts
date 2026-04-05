/**
 * Plugin system types.
 */

import type { z } from "zod";

export interface PluginDefinition {
  name: string;
  version: string;
  description: string;
  author?: string;
  hooks?: PluginHooks;
  configSchema?: z.ZodType<unknown>;
}

export interface PluginHooks {
  onStartup?: (ctx: PluginContext) => Promise<void>;
  onShutdown?: (ctx: PluginContext) => Promise<void>;
  onSessionCreated?: (ctx: PluginContext, sessionId: string) => Promise<void>;
  onSessionArchived?: (ctx: PluginContext, sessionId: string) => Promise<void>;
  onPromptReceived?: (ctx: PluginContext, prompt: string) => Promise<string>;
  onAfterAgentRun?: (ctx: PluginContext, agentId: string, result: unknown) => Promise<void>;
  onToolCall?: (ctx: PluginContext, toolName: string, input: unknown) => Promise<void>;
  onFileModified?: (ctx: PluginContext, filePath: string, agentId: string) => Promise<void>;
  onCostUpdate?: (ctx: PluginContext, cost: unknown) => Promise<void>;
  onError?: (ctx: PluginContext, error: unknown) => Promise<void>;
}

export interface PluginContext {
  config: unknown;
  logger: PluginLogger;
  emit: (event: string, data: unknown) => void;
}

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type PluginError =
  | { type: "invalid_plugin"; name: string; cause: string }
  | { type: "hook_error"; plugin: string; hook: string; cause: string }
  | { type: "hook_timeout"; plugin: string; hook: string; timeoutMs: number }
  | { type: "load_failed"; path: string; cause: string };
