/**
 * Shared streaming types used by all providers, cache interceptor, and proxy.
 * Extracted from client/types.ts so downstream code doesn't pull in client types.
 */

export interface StreamOptions {
  /** Model to use for the completion */
  model?: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** System prompt prepended to the conversation */
  systemPrompt?: string;
  /** AbortSignal to cancel the stream mid-flight */
  signal?: AbortSignal;
}

export interface StreamChunk {
  /** Incremental text content from the model */
  content: string;
  /** True when this is the final chunk (stream finished) */
  done: boolean;
  /** Token usage stats, present only on the final chunk when reported */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** Anthropic prompt caching: tokens read from cache (90% cheaper) */
    cacheReadTokens?: number;
    /** Anthropic prompt caching: tokens written to cache (1.25x cost) */
    cacheCreationTokens?: number;
  };
}
