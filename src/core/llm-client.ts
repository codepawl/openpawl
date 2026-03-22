/**
 * LLM client — uses ProviderManager for all LLM completions.
 */

import { CONFIG, getSessionTemperature } from "./config.js";
import { logger, isDebugMode } from "./logger.js";
import { getTrafficController } from "./traffic-control.js";
import { resolveModelForAgent } from "./model-config.js";
import { llmEvents } from "./llm-events.js";
import { getLlmCache } from "./llm-cache.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";

export interface GenerateOptions {
  temperature?: number;
  model?: string;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
}

function shortErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export async function generate(prompt: string, options?: GenerateOptions & { botId?: string }): Promise<string> {
  const botId = options?.botId ?? "coordinator";
  const trafficController = getTrafficController();

  const canProceed = await trafficController.acquire(botId);
  if (!canProceed) {
    throw new Error("Traffic control: Session paused due to safety limit. Please restart the work session.");
  }

  const temperature = options?.temperature ?? getSessionTemperature();
  const promptChars = prompt.length;
  const model = options?.model ?? resolveModelForAgent(botId);
  const isStreaming = !!options?.onChunk;

  // Cache check: skip streaming requests
  if (!isStreaming) {
    const llmCache = getLlmCache();
    const cacheKey = llmCache.buildKey(prompt, model, temperature);
    const cached = llmCache.get(cacheKey);
    if (cached !== null) {
      llmEvents.emit("log", {
        id: `llm-cache-hit-${Date.now()}`,
        level: "success",
        source: "llm-client",
        action: "cache_hit",
        model,
        botId,
        message: `Cache hit for ${botId} (${promptChars} chars saved)`,
        meta: { promptChars },
        timestamp: Date.now(),
      });
      trafficController.release(botId);
      return cached;
    }
  }

  const startedAt = Date.now();
  llmEvents.emit("log", {
    id: `llm-${Date.now()}-0`,
    level: "info",
    source: "llm-client",
    action: "request_start",
    model,
    botId,
    message: `LLM request → ${model || "default"}`,
    meta: { promptChars },
    timestamp: Date.now(),
  });
  if (isDebugMode()) {
    logger.agent(`LLM request start: model=${model || "default"} promptChars=${promptChars}`);
  }

  try {
    const mgr = getGlobalProviderManager();

    if (isStreaming) {
      // Streaming mode — yield chunks via callback
      const chunks: string[] = [];
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined;
      for await (const chunk of mgr.stream(prompt, {
        model: model || undefined,
        temperature,
        signal: AbortSignal.timeout(CONFIG.llmTimeoutMs),
      })) {
        if (chunk.content) {
          chunks.push(chunk.content);
          options!.onChunk!(chunk.content);
          llmEvents.emit("stream_chunk", {
            botId,
            model,
            chunk: chunk.content,
            timestamp: Date.now(),
          });
        }
        if (chunk.done && chunk.usage) {
          streamUsage = chunk.usage;
        }
      }
      const text = chunks.join("").trim();
      const elapsedMs = Date.now() - startedAt;
      llmEvents.emit("log", {
        id: `llm-${Date.now()}-end`,
        level: "success",
        source: "llm-client",
        action: "request_end",
        model,
        botId,
        message: `Response in ${elapsedMs}ms (${text.length} chars)`,
        meta: { elapsedMs, responseChars: text.length, ...(streamUsage ?? {}) },
        timestamp: Date.now(),
      });
      trafficController.release(botId);
      return text;
    }

    // Non-streaming mode
    const result = await mgr.generate(prompt, {
      model: model || undefined,
      temperature,
      signal: AbortSignal.timeout(CONFIG.llmTimeoutMs),
    });

    const responseText = result.text.trim();
    const elapsedMs = Date.now() - startedAt;

    llmEvents.emit("log", {
      id: `llm-${Date.now()}-end`,
      level: "success",
      source: "llm-client",
      action: "request_end",
      model,
      botId,
      message: `Response in ${elapsedMs}ms (${responseText.length} chars)`,
      meta: { elapsedMs, responseChars: responseText.length, ...(result.usage ?? {}) },
      timestamp: Date.now(),
    });
    if (isDebugMode()) {
      logger.agent(`LLM request end: elapsedMs=${elapsedMs}`);
    }

    // Cache successful non-streaming responses
    if (responseText) {
      const llmCache = getLlmCache();
      const storageKey = llmCache.buildKey(prompt, model, temperature);
      llmCache.set(storageKey, responseText, promptChars, model);
    }

    trafficController.release(botId);
    return responseText;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    llmEvents.emit("log", {
      id: `llm-${Date.now()}-error`,
      level: "error",
      source: "llm-client",
      action: "request_error",
      model,
      botId,
      message: `Request failed: ${shortErr(err)}`,
      meta: { elapsedMs, error: shortErr(err) },
      timestamp: Date.now(),
    });
    if (isDebugMode()) {
      logger.agent(`LLM request error: elapsedMs=${elapsedMs} err="${shortErr(err)}"`);
    }
    trafficController.release(botId);
    throw err;
  }
}

export async function llmHealthCheck(): Promise<boolean> {
  const { isMockLlmEnabled } = await import("./mock-llm.js");
  if (isMockLlmEnabled()) return true;

  try {
    const mgr = getGlobalProviderManager();
    const providers = mgr.getProviders();
    if (providers.length === 0) return false;

    for (const p of providers) {
      if (p.isAvailable() && (await p.healthCheck())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** @deprecated Use resolveModelForAgent() directly. */
export async function getEffectiveModel(): Promise<string> {
  return resolveModelForAgent("coordinator");
}
