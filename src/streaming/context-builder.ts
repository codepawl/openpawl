/**
 * Builds complete LLM message array for agent calls.
 * Combines system prompt + session history + tools + user prompt.
 */

import { Result, ok, err } from "neverthrow";
import type { ToolRegistry } from "../tools/registry.js";
import type { LLMToolSchema } from "../tools/types.js";
import type { NativeToolDefinition } from "../providers/stream-types.js";
import type { Session } from "../session/session.js";
import type { LLMMessage, StreamError } from "./types.js";

export interface BuiltContext {
  messages: LLMMessage[];
  toolSchemas: LLMToolSchema[];
  /** Native tool definitions for API function calling. */
  nativeTools: NativeToolDefinition[];
  estimatedTokens: number;
  compressionApplied: boolean;
}

export class ContextBuilder {
  constructor(private toolRegistry: ToolRegistry) {}

  build(options: {
    session: Session;
    agentId: string;
    agentSystemPrompt: string;
    prompt: string;
    tools: string[];
    maxContextTokens?: number;
    includeHistory?: boolean;
    additionalContext?: string;
  }): Result<BuiltContext, StreamError> {
    try {
      const messages: LLMMessage[] = [];
      const maxTokens = options.maxContextTokens ?? 100_000;

      // 1. System message
      const systemContent = options.agentSystemPrompt || `You are ${options.agentId}, an AI assistant.`;

      // Tools are now passed via native API tool calling (not system prompt).
      // Export native tool definitions for the provider.
      const nativeTools = this.toolRegistry.exportForAPI(options.tools);

      messages.push({ role: "system", content: systemContent });

      // 2. Session history (if enabled)
      if (options.includeHistory !== false) {
        const historyMessages = options.session.buildContextMessages(maxTokens);
        for (const msg of historyMessages) {
          if (msg.role === "system") continue; // Skip session system messages
          messages.push({
            role: msg.role as LLMMessage["role"],
            content: msg.content,
          });
        }
      }

      // 3. Additional context (for sequential dispatch)
      if (options.additionalContext) {
        messages.push({
          role: "user",
          content: `Previous agent output:\n${options.additionalContext}`,
        });
      }

      // 4. Current prompt
      messages.push({ role: "user", content: options.prompt });

      // 5. Token estimation
      const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

      if (estimatedTokens > maxTokens) {
        return err({
          type: "context_too_large",
          estimatedTokens,
          maxTokens,
        });
      }

      return ok({
        messages,
        toolSchemas: nativeTools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
        nativeTools,
        estimatedTokens,
        compressionApplied: false,
      });
    } catch (e) {
      return err({ type: "serialization_error", cause: String(e) });
    }
  }
}
