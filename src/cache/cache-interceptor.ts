/**
 * Cache interceptor — wraps ProxyService.stream() with cache lookup/store.
 *
 * Cache reads complete in <10ms (filesystem).
 * Cache writes never block the stream (async fire-and-forget).
 */

import type { StreamChunk } from "../providers/stream-types.js";
import { ResponseCacheStore, buildCacheKey, hasSessionSpecificContent } from "./cache-store.js";
import {
  CACHE_TTL,
  NEVER_CACHE_ROLES,
  MIN_CACHE_RESPONSE_LENGTH,
} from "./types.js";
import type { CacheEntry, SessionCacheStats } from "./types.js";
import { logger } from "../core/logger.js";

const store = new ResponseCacheStore();
let storeReady = false;

const sessionStats: SessionCacheStats = {
  hits: 0,
  misses: 0,
  savedMs: 0,
};

export function getSessionCacheStats(): SessionCacheStats {
  return { ...sessionStats };
}

export function resetSessionCacheStats(): void {
  sessionStats.hits = 0;
  sessionStats.misses = 0;
  sessionStats.savedMs = 0;
}

async function ensureStore(): Promise<void> {
  if (!storeReady) {
    await store.init();
    storeReady = true;
  }
}

function isCacheEnabled(): boolean {
  return process.env.OPENPAWL_NO_CACHE !== "true";
}

function isCacheableRole(role: string): boolean {
  return !NEVER_CACHE_ROLES.has(role);
}

function getTTL(role: string): number {
  return CACHE_TTL[role] ?? CACHE_TTL["default"]!;
}

/**
 * Wrap a stream generator with cache logic.
 * If cache hit: yields cached response as a single chunk pair.
 * If cache miss: passes through original stream, stores result async.
 */
export async function* streamWithCache(
  prompt: string,
  model: string,
  agentRole: string,
  originalStream: AsyncGenerator<StreamChunk, void, undefined>,
): AsyncGenerator<StreamChunk, void, undefined> {
  // Bypass: env var, non-cacheable role, or session-specific content
  if (!isCacheEnabled() || !isCacheableRole(agentRole) || hasSessionSpecificContent(prompt)) {
    sessionStats.misses++;
    yield* originalStream;
    return;
  }

  const key = buildCacheKey(prompt, model, agentRole);

  // Try cache read (fast path — filesystem)
  try {
    await ensureStore();
    const cached = await store.get(key);
    if (cached) {
      sessionStats.hits++;
      const savedMs = 3000; // estimated time saved per hit
      sessionStats.savedMs += savedMs;
      logger.debug(`[cache hit] ${agentRole} (saved ~${(savedMs / 1000).toFixed(1)}s)`);

      // Yield cached response as single chunk
      yield { content: cached.response, done: false };
      yield { content: "", done: true, usage: { promptTokens: 0, completionTokens: 0 } };
      return;
    }
  } catch {
    // Cache read failed — fall through to original stream
  }

  // Cache miss — stream from origin, collect response
  sessionStats.misses++;
  const chunks: string[] = [];
  let tokensUsed = 0;

  for await (const chunk of originalStream) {
    chunks.push(chunk.content);
    if (chunk.done && chunk.usage) {
      tokensUsed = (chunk.usage.promptTokens ?? 0) + (chunk.usage.completionTokens ?? 0);
    }
    yield chunk;
  }

  // Store in cache async (never block)
  const fullResponse = chunks.join("");
  if (fullResponse.length >= MIN_CACHE_RESPONSE_LENGTH) {
    const now = Date.now();
    const entry: CacheEntry = {
      key,
      prompt,
      model,
      agentRole,
      response: fullResponse,
      tokensUsed,
      hitCount: 0,
      createdAt: now,
      lastHitAt: now,
      expiresAt: now + getTTL(agentRole),
    };

    // Fire-and-forget — do not await
    ensureStore()
      .then(() => store.set(entry))
      .catch(() => {
        logger.debug("[cache] failed to write cache entry");
      });
  }
}
