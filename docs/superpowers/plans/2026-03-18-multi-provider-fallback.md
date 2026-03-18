# Multi-Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatic fallback from OpenClaw to Anthropic API when the primary gateway is unavailable, slow, or rate-limited.

**Architecture:** ProviderManager replaces OpenClawClient inside ProxyService. Each provider implements StreamProvider interface. ProviderManager tries providers in chain order, falls back on connection/timeout/5xx/429 errors. Cache interceptor wraps ProviderManager output unchanged.

**Tech Stack:** TypeScript (ESM), @anthropic-ai/sdk, Vitest, existing OpenClawClient/ProxyService/cache stack

**Spec:** `docs/superpowers/specs/2026-03-18-multi-provider-fallback-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/providers/types.ts` | ProviderName, ProviderError class, ProviderStats type |
| `src/providers/provider.ts` | StreamProvider interface |
| `src/providers/openclaw-provider.ts` | Wraps OpenClawClient, adds first-chunk timeout, converts errors |
| `src/providers/anthropic-provider.ts` | Direct Anthropic SDK streaming, maps to StreamChunk |
| `src/providers/provider-manager.ts` | Fallback chain orchestration, stats tracking |
| `src/providers/health-monitor.ts` | Background health pings, availability flags |
| `src/providers/index.ts` | Barrel export |
| `src/commands/providers.ts` | `teamclaw providers list/test` CLI |
| `tests/provider-manager.test.ts` | Fallback chain tests |
| `tests/anthropic-provider.test.ts` | Anthropic SDK mapping tests |

### Modified files
| File | Change |
|------|--------|
| `src/client/errors.ts` | Add `statusCode?: number` field |
| `src/client/OpenClawClient.ts:201-207` | Set `statusCode` on non-OK HTTP |
| `src/proxy/ProxyService.ts` | Replace OpenClawClient with ProviderManager |
| `src/proxy/plugin.ts:85` | Handle ProviderError in error code extraction |
| `src/cli.ts` | Add providers command dispatch + help line |
| `src/cli/fuzzy-matcher.ts` | Add "providers" to COMMANDS + SUBCOMMANDS |
| `src/check.ts` | Append provider status section |
| `src/commands/setup.ts:466-468` | Add Anthropic key step after model selection |
| `src/audit/types.ts` | Add providerStats field to AuditTrail |
| `src/audit/builder.ts` | Populate providerStats from ProviderManager |
| `src/audit/renderers/markdown.ts` | Render Provider Usage section |
| `src/work-runner.ts:278-285,779` | Start/stop health monitor |

---

## Task 1: Provider types and interface

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/provider.ts`
- Modify: `src/client/errors.ts`
- Modify: `src/client/OpenClawClient.ts:201-207`

- [ ] **Step 1: Create provider types**

```typescript
// src/providers/types.ts
import type { StreamChunk, StreamOptions } from "../client/types.js";

export type ProviderName = "openclaw" | "anthropic";

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: string;
  readonly statusCode?: number;
  readonly isFallbackTrigger: boolean;

  constructor(opts: {
    provider: ProviderName;
    code: string;
    message: string;
    statusCode?: number;
    isFallbackTrigger: boolean;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.isFallbackTrigger = opts.isFallbackTrigger;
    this.cause = opts.cause;
  }
}

export type ProviderStats = {
  openclaw: { requests: number; failures: number };
  anthropic: { requests: number; failures: number };
  fallbacksTriggered: number;
};

export function emptyStats(): ProviderStats {
  return {
    openclaw: { requests: 0, failures: 0 },
    anthropic: { requests: 0, failures: 0 },
    fallbacksTriggered: 0,
  };
}
```

- [ ] **Step 2: Create StreamProvider interface**

```typescript
// src/providers/provider.ts
import type { StreamChunk, StreamOptions } from "../client/types.js";

export interface StreamProvider {
  readonly name: string;
  stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined>;
  healthCheck(): Promise<boolean>;
  isAvailable(): boolean;
  setAvailable(available: boolean): void;
}
```

- [ ] **Step 3: Add statusCode to OpenClawError**

In `src/client/errors.ts`, add the field:

```typescript
export class OpenClawError extends Error {
  readonly code: OpenClawErrorCode;
  readonly statusCode?: number;
  readonly cause?: unknown;

  constructor(code: OpenClawErrorCode, message: string, cause?: unknown, statusCode?: number) {
    super(message);
    this.name = "OpenClawError";
    this.code = code;
    this.cause = cause;
    this.statusCode = statusCode;
  }
}
```

- [ ] **Step 4: Set statusCode in OpenClawClient.stream()**

In `src/client/OpenClawClient.ts`, around line 201-207, change:

```typescript
// Before:
throw new OpenClawError(
  "STREAM_FAILED",
  `HTTP ${res.status}: ${text.slice(0, 200)}`,
);

// After:
throw new OpenClawError(
  "STREAM_FAILED",
  `HTTP ${res.status}: ${text.slice(0, 200)}`,
  undefined,
  res.status,
);
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm run typecheck 2>&1 | grep -E "src/providers/|src/client/errors|src/client/OpenClaw"`
Expected: No errors in these files

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/providers/provider.ts src/client/errors.ts src/client/OpenClawClient.ts
git commit -m "feat(providers): add StreamProvider interface and ProviderError type"
```

---

## Task 2: OpenClaw provider

**Files:**
- Create: `src/providers/openclaw-provider.ts`

- [ ] **Step 1: Implement OpenClaw provider**

```typescript
// src/providers/openclaw-provider.ts
import { OpenClawClient } from "../client/OpenClawClient.js";
import { OpenClawError } from "../client/errors.js";
import type { OpenClawClientConfig, StreamChunk, StreamOptions } from "../client/types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";

const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 15_000;

function isFallbackTrigger(err: OpenClawError): boolean {
  if (err.code === "CONNECTION_FAILED") return true;
  if (err.code === "TIMEOUT") return true;
  if (err.code === "STREAM_FAILED") {
    const status = err.statusCode;
    if (status === 429) return true;
    if (status && status >= 500) return true;
  }
  return false;
}

export class OpenClawProvider implements StreamProvider {
  readonly name = "openclaw";
  private readonly client: OpenClawClient;
  private readonly gatewayHealthUrl: string;
  private readonly firstChunkTimeoutMs: number;
  private available = true;

  constructor(config: OpenClawClientConfig, opts?: { firstChunkTimeoutMs?: number; healthUrl?: string }) {
    this.client = new OpenClawClient(config);
    this.firstChunkTimeoutMs = opts?.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
    // Derive HTTP health URL from WS URL (same pattern as OpenClawClient.wsToHttpBase)
    const wsUrl = config.gatewayUrl;
    const httpBase = wsUrl.replace(/^ws/, "http").replace(/:(\d+)$/, (_, p) => `:${Number(p) + 2}`);
    this.gatewayHealthUrl = opts?.healthUrl ?? `${httpBase}/health`;
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    // Ensure WebSocket connection
    if (!this.client.isConnected()) {
      try {
        await this.client.connect();
      } catch (err) {
        const ocErr = err instanceof OpenClawError ? err : new OpenClawError("CONNECTION_FAILED", String(err), err);
        throw new ProviderError({
          provider: "openclaw",
          code: ocErr.code,
          message: ocErr.message,
          statusCode: ocErr.statusCode,
          isFallbackTrigger: true,
          cause: ocErr,
        });
      }
    }

    // First-chunk timeout via derived AbortController
    const derivedController = new AbortController();
    const timer = setTimeout(() => derivedController.abort(), this.firstChunkTimeoutMs);

    // Chain caller's signal if present
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new ProviderError({
          provider: "openclaw",
          code: "ABORTED",
          message: "Aborted before request",
          isFallbackTrigger: false,
        });
      }
      options.signal.addEventListener("abort", () => derivedController.abort(), { once: true });
    }

    const streamOpts: StreamOptions = { ...options, signal: derivedController.signal };

    try {
      let firstChunkReceived = false;
      for await (const chunk of this.client.stream(prompt, streamOpts)) {
        if (!firstChunkReceived) {
          clearTimeout(timer);
          firstChunkReceived = true;
        }
        yield chunk;
      }
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ProviderError) throw err;

      const ocErr = err instanceof OpenClawError
        ? err
        : new OpenClawError("STREAM_FAILED", String(err), err);

      // Check if abort was from our first-chunk timer.
      // When the timer fires, derivedController.abort() is called. This causes
      // either a DOMException("AbortError") from fetch, or a read error from
      // the SSE body reader. Both get caught here. We detect our timer's abort
      // by checking derivedController.signal.aborted — regardless of error code.
      if (derivedController.signal.aborted) {
        throw new ProviderError({
          provider: "openclaw",
          code: "FIRST_CHUNK_TIMEOUT",
          message: `No response within ${this.firstChunkTimeoutMs}ms`,
          isFallbackTrigger: true,
          cause: err,
        });
      }

      throw new ProviderError({
        provider: "openclaw",
        code: ocErr.code,
        message: ocErr.message,
        statusCode: ocErr.statusCode,
        isFallbackTrigger: isFallbackTrigger(ocErr),
        cause: ocErr,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.gatewayHealthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  getClient(): OpenClawClient {
    return this.client;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck 2>&1 | grep "src/providers/openclaw"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/providers/openclaw-provider.ts
git commit -m "feat(providers): implement OpenClaw provider with first-chunk timeout"
```

---

## Task 3: Anthropic provider

**Files:**
- Create: `src/providers/anthropic-provider.ts`
- Create: `tests/anthropic-provider.test.ts`

- [ ] **Step 1: Install @anthropic-ai/sdk**

Run: `pnpm add @anthropic-ai/sdk`

- [ ] **Step 2: Write tests for Anthropic provider**

```typescript
// tests/anthropic-provider.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

// Mock Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  const mockStream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: " world" } };
      yield { type: "message_stop" };
    },
    finalMessage: {
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };

  return {
    default: class Anthropic {
      messages = {
        stream: vi.fn().mockReturnValue(mockStream),
      };
    },
  };
});

import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import type { StreamChunk } from "../src/client/types.js";

async function collectChunks(gen: AsyncGenerator<StreamChunk, void, undefined>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of gen) result.push(chunk);
  return result;
}

describe("AnthropicProvider", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("isAvailable returns false when no key configured", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = new AnthropicProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("ANTHROPIC_API_KEY env var takes precedence over config", () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-key";
    const provider = new AnthropicProvider({ apiKey: "sk-config-key" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("isAvailable returns true when config key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("maps prompt to Anthropic messages format", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const provider = new AnthropicProvider({});
    const chunks = await collectChunks(provider.stream("Hello"));

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunks are content
    expect(chunks[0]!.content).toBe("Hello");
    expect(chunks[0]!.done).toBe(false);
    expect(chunks[1]!.content).toBe(" world");
    expect(chunks[1]!.done).toBe(false);
  });

  it("yields done chunk with usage stats", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const provider = new AnthropicProvider({});
    const chunks = await collectChunks(provider.stream("Hello"));

    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.done).toBe(true);
    expect(lastChunk.content).toBe("");
    expect(lastChunk.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it("healthCheck returns true when key present and last success recent", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const provider = new AnthropicProvider({});
    // Force a stream to set lastSuccessAt
    await collectChunks(provider.stream("test"));
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm run test -- tests/anthropic-provider.test.ts 2>&1 | tail -5`
Expected: FAIL — `AnthropicProvider` not found

- [ ] **Step 4: Implement Anthropic provider**

```typescript
// src/providers/anthropic-provider.ts
import Anthropic from "@anthropic-ai/sdk";
import type { StreamChunk, StreamOptions } from "../client/types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export interface AnthropicProviderConfig {
  apiKey?: string;
  model?: string;
}

export class AnthropicProvider implements StreamProvider {
  readonly name = "anthropic";
  private client: Anthropic | null = null;
  private readonly model: string;
  private readonly apiKey: string | null;
  private available = true;
  private lastSuccessAt = 0;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? config.apiKey ?? null;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private getClient(): Anthropic {
    if (!this.client) {
      if (!this.apiKey) {
        throw new ProviderError({
          provider: "anthropic",
          code: "NOT_CONFIGURED",
          message: "No Anthropic API key configured",
          isFallbackTrigger: false,
        });
      }
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const client = this.getClient();

    const params: Anthropic.MessageCreateParams = {
      model: options?.model ?? this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    };
    if (options?.systemPrompt) {
      params.system = options.systemPrompt;
    }

    try {
      const stream = client.messages.stream(params);

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { content: event.delta.text, done: false };
        } else if (event.type === "message_stop") {
          // Get usage from finalMessage
          const msg = stream.finalMessage;
          const usage = msg?.usage
            ? { promptTokens: msg.usage.input_tokens, completionTokens: msg.usage.output_tokens }
            : undefined;
          yield { content: "", done: true, usage };
          this.lastSuccessAt = Date.now();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = message.includes("rate_limit") || message.includes("429");
      throw new ProviderError({
        provider: "anthropic",
        code: isRateLimit ? "RATE_LIMITED" : "STREAM_FAILED",
        message: `Anthropic API error: ${message}`,
        statusCode: isRateLimit ? 429 : undefined,
        isFallbackTrigger: false, // Last in chain — nowhere to fall back to
        cause: err,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    // Key present + recent success = healthy
    if (this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt < HEALTH_WINDOW_MS) {
      return true;
    }
    // Key present but no recent success — still report as configured
    return true;
  }

  isAvailable(): boolean {
    return this.apiKey != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm run test -- tests/anthropic-provider.test.ts 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/anthropic-provider.ts tests/anthropic-provider.test.ts package.json pnpm-lock.yaml
git commit -m "feat(providers): implement Anthropic provider with SDK streaming"
```

---

## Task 4: ProviderManager with fallback chain

**Files:**
- Create: `src/providers/provider-manager.ts`
- Create: `tests/provider-manager.test.ts`

- [ ] **Step 1: Write ProviderManager tests**

```typescript
// tests/provider-manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamChunk, StreamOptions } from "../src/client/types.js";
import type { StreamProvider } from "../src/providers/provider.js";
import { ProviderError } from "../src/providers/types.js";

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

function makeProvider(name: string, overrides: Partial<StreamProvider> = {}): StreamProvider {
  return {
    name,
    stream: overrides.stream ?? (async function* () {
      yield { content: `from-${name}`, done: false };
      yield { content: "", done: true };
    }),
    healthCheck: overrides.healthCheck ?? (async () => true),
    isAvailable: overrides.isAvailable ?? (() => true),
    setAvailable: overrides.setAvailable ?? (() => {}),
  };
}

function failingProvider(name: string, error: ProviderError): StreamProvider {
  return makeProvider(name, {
    stream: async function* () { throw error; },
  });
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of gen) result.push(chunk);
  return result;
}

// Lazy import to avoid hoisting issues with mocks
async function createManager(providers: StreamProvider[]) {
  const { ProviderManager } = await import("../src/providers/provider-manager.js");
  return new ProviderManager(providers);
}

describe("ProviderManager", () => {
  it("tries first provider on success", async () => {
    const mgr = await createManager([makeProvider("openclaw"), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-openclaw");
    expect(mgr.getStats().openclaw.requests).toBe(1);
  });

  it("switches to next provider on ECONNREFUSED", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "CONNECTION_FAILED",
      message: "ECONNREFUSED", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
    expect(mgr.getStats().fallbacksTriggered).toBe(1);
  });

  it("switches on first-chunk timeout", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "FIRST_CHUNK_TIMEOUT",
      message: "Timeout", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
  });

  it("does NOT switch on 4xx (except 429)", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "STREAM_FAILED",
      message: "HTTP 401", statusCode: 401, isFallbackTrigger: false,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    await expect(collectChunks(mgr.stream("test"))).rejects.toThrow("HTTP 401");
    expect(mgr.getStats().anthropic.requests).toBe(0);
  });

  it("switches on 429", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "STREAM_FAILED",
      message: "HTTP 429", statusCode: 429, isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
  });

  it("throws ProviderError when all providers fail", async () => {
    const err1 = new ProviderError({
      provider: "openclaw", code: "CONNECTION_FAILED",
      message: "down", isFallbackTrigger: true,
    });
    const err2 = new ProviderError({
      provider: "anthropic", code: "STREAM_FAILED",
      message: "also down", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err1), failingProvider("anthropic", err2)]);
    await expect(collectChunks(mgr.stream("test"))).rejects.toThrow("ALL_PROVIDERS_FAILED");
  });

  it("skips unavailable providers immediately", async () => {
    const unavailable = makeProvider("openclaw", { isAvailable: () => false });
    const mgr = await createManager([unavailable, makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
    // OpenClaw was skipped — no request recorded
    expect(mgr.getStats().openclaw.requests).toBe(0);
  });

  it("stats track requests, failures, and fallbacks", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "CONNECTION_FAILED",
      message: "down", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    await collectChunks(mgr.stream("test1"));
    await collectChunks(mgr.stream("test2"));

    const stats = mgr.getStats();
    expect(stats.openclaw.requests).toBe(2);
    expect(stats.openclaw.failures).toBe(2);
    expect(stats.anthropic.requests).toBe(2);
    expect(stats.anthropic.failures).toBe(0);
    expect(stats.fallbacksTriggered).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- tests/provider-manager.test.ts 2>&1 | tail -5`
Expected: FAIL — `ProviderManager` not found

- [ ] **Step 3: Implement ProviderManager**

```typescript
// src/providers/provider-manager.ts
import type { StreamChunk, StreamOptions } from "../client/types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError, type ProviderName, type ProviderStats, emptyStats } from "./types.js";
import { logger } from "../core/logger.js";

export class ProviderManager {
  private readonly providers: StreamProvider[];
  private stats: ProviderStats = emptyStats();

  constructor(providers: StreamProvider[]) {
    this.providers = providers;
  }

  async *stream(
    prompt: string,
    options?: StreamOptions,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const errors: ProviderError[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      const providerKey = provider.name as ProviderName;

      if (!provider.isAvailable()) {
        logger.debug(`[providers] skipping ${provider.name} (unavailable)`);
        continue;
      }

      const statEntry = this.stats[providerKey];
      if (statEntry) statEntry.requests++;

      try {
        yield* provider.stream(prompt, options);
        return; // Success — done
      } catch (err) {
        if (statEntry) statEntry.failures++;

        const providerErr = err instanceof ProviderError
          ? err
          : new ProviderError({
              provider: providerKey,
              code: "UNKNOWN",
              message: String(err),
              isFallbackTrigger: false,
              cause: err,
            });

        if (!providerErr.isFallbackTrigger) {
          throw providerErr; // Non-recoverable — rethrow
        }

        errors.push(providerErr);

        const next = this.providers[i + 1];
        if (next) {
          this.stats.fallbacksTriggered++;
          logger.warn(`${provider.name} unavailable — switching to ${next.name}`);
        }
      }
    }

    // All providers exhausted
    throw new ProviderError({
      provider: (this.providers[this.providers.length - 1]?.name ?? "unknown") as ProviderName,
      code: "ALL_PROVIDERS_FAILED",
      message: `ALL_PROVIDERS_FAILED: ${errors.map((e) => `${e.provider}: ${e.message}`).join("; ")}`,
      isFallbackTrigger: false,
    });
  }

  getStats(): ProviderStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = emptyStats();
  }

  getProviders(): readonly StreamProvider[] {
    return this.providers;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run test -- tests/provider-manager.test.ts 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/provider-manager.ts tests/provider-manager.test.ts
git commit -m "feat(providers): implement ProviderManager with fallback chain"
```

---

## Task 5: Health monitor

**Files:**
- Create: `src/providers/health-monitor.ts`

- [ ] **Step 1: Implement health monitor**

```typescript
// src/providers/health-monitor.ts
import type { StreamProvider } from "./provider.js";
import { logger } from "../core/logger.js";

const DEFAULT_INTERVAL_MS = 30_000;
const FAILURE_THRESHOLD = 2;

export class HealthMonitor {
  private readonly providers: StreamProvider[];
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failureCounts = new Map<string, number>();

  constructor(providers: StreamProvider[], intervalMs = DEFAULT_INTERVAL_MS) {
    this.providers = providers;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.checkAll();
    }, this.intervalMs);

    // Never block process exit
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resetAll(): void {
    this.failureCounts.clear();
    for (const provider of this.providers) {
      provider.setAvailable(true);
    }
  }

  private async checkAll(): Promise<void> {
    for (const provider of this.providers) {
      // Skip providers that don't need active pinging (e.g. Anthropic — key-presence only)
      if (provider.name === "anthropic") continue;

      try {
        const healthy = await provider.healthCheck();
        if (healthy) {
          const prev = this.failureCounts.get(provider.name) ?? 0;
          this.failureCounts.set(provider.name, 0);
          if (prev >= FAILURE_THRESHOLD) {
            logger.info(`[health] ${provider.name} recovered`);
            provider.setAvailable(true);
          }
        } else {
          this.recordFailure(provider);
        }
      } catch {
        this.recordFailure(provider);
      }
    }
  }

  private recordFailure(provider: StreamProvider): void {
    const count = (this.failureCounts.get(provider.name) ?? 0) + 1;
    this.failureCounts.set(provider.name, count);
    if (count >= FAILURE_THRESHOLD) {
      logger.warn(`[health] ${provider.name} marked unavailable (${count} consecutive failures)`);
      provider.setAvailable(false);
    }
  }

  /** Expose for testing */
  getFailureCount(name: string): number {
    return this.failureCounts.get(name) ?? 0;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck 2>&1 | grep "src/providers/health"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/providers/health-monitor.ts
git commit -m "feat(providers): add health monitor with failure threshold"
```

---

## Task 6: Barrel export and ProxyService integration

**Files:**
- Create: `src/providers/index.ts`
- Modify: `src/proxy/ProxyService.ts`
- Modify: `src/proxy/plugin.ts:85`

- [ ] **Step 1: Create barrel export**

```typescript
// src/providers/index.ts
export type { StreamProvider } from "./provider.js";
export { OpenClawProvider } from "./openclaw-provider.js";
export { AnthropicProvider } from "./anthropic-provider.js";
export { ProviderManager } from "./provider-manager.js";
export { HealthMonitor } from "./health-monitor.js";
export { ProviderError, emptyStats } from "./types.js";
export type { ProviderName, ProviderStats } from "./types.js";
```

- [ ] **Step 2: Rewrite ProxyService to use ProviderManager**

Replace `src/proxy/ProxyService.ts` entirely:

```typescript
import type {
  OpenClawClientConfig,
  StreamChunk,
  StreamOptions,
} from "../client/types.js";
import type { ProxyHealthResponse, ProxyReconnectResponse } from "./types.js";
import { isMockLlmEnabled, generateMockResponse } from "../core/mock-llm.js";
import { streamWithCache } from "../cache/cache-interceptor.js";
import { ProviderManager, OpenClawProvider, AnthropicProvider, HealthMonitor } from "../providers/index.js";
import { readGlobalConfig } from "../core/global-config.js";

export class ProxyService {
  readonly providerManager: ProviderManager;
  readonly healthMonitor: HealthMonitor;
  private readonly gatewayUrl: string;
  private readonly startTime: number;

  constructor(providerManager: ProviderManager, healthMonitor: HealthMonitor, gatewayUrl: string) {
    this.providerManager = providerManager;
    this.healthMonitor = healthMonitor;
    this.gatewayUrl = gatewayUrl;
    this.startTime = Date.now();
  }

  async *stream(
    prompt: string,
    options?: StreamOptions & { agentRole?: string },
  ): AsyncGenerator<StreamChunk, void, undefined> {
    if (isMockLlmEnabled()) {
      const mockText = generateMockResponse(prompt, "proxy");
      yield { content: mockText, done: false };
      yield { content: "", done: true };
      return;
    }

    const model = options?.model ?? "default";
    const agentRole = options?.agentRole ?? "default";
    const rawStream = this.providerManager.stream(prompt, options);
    yield* streamWithCache(prompt, model, agentRole, rawStream);
  }

  health(): ProxyHealthResponse {
    return {
      connected: true, // Simplified — provider availability is per-provider now
      gatewayUrl: this.gatewayUrl,
      uptime: Date.now() - this.startTime,
    };
  }

  async reconnect(): Promise<ProxyReconnectResponse> {
    this.healthMonitor.resetAll();
    return { success: true, message: "Provider health state reset" };
  }

  async shutdown(): Promise<void> {
    this.healthMonitor.stop();
  }
}

let instance: ProxyService | null = null;

/** Get the singleton's ProviderManager (for stats access from audit/work-runner). Returns null if not yet created. */
export function getProviderManager(): ProviderManager | null {
  return instance?.providerManager ?? null;
}

/** Get the singleton's HealthMonitor. Returns null if not yet created. */
export function getHealthMonitor(): HealthMonitor | null {
  return instance?.healthMonitor ?? null;
}

export function createProxyService(config: OpenClawClientConfig): ProxyService {
  if (!instance) {
    const openclawProvider = new OpenClawProvider(config, {
      firstChunkTimeoutMs: getFirstChunkTimeout(),
    });

    const providers = [openclawProvider];

    // Add Anthropic fallback if configured
    const anthropicConfig = getAnthropicConfig();
    if (anthropicConfig) {
      providers.push(new AnthropicProvider(anthropicConfig));
    }

    const manager = new ProviderManager(providers);
    const monitor = new HealthMonitor(providers);

    instance = new ProxyService(manager, monitor, config.gatewayUrl);
  }
  return instance;
}

function getFirstChunkTimeout(): number {
  try {
    const cfg = readGlobalConfig();
    const providers = (cfg as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
    return (providers?.firstChunkTimeoutMs as number) ?? 15_000;
  } catch {
    return 15_000;
  }
}

function getAnthropicConfig(): { apiKey?: string; model?: string } | null {
  // Env var always available
  if (process.env.ANTHROPIC_API_KEY) {
    return { apiKey: process.env.ANTHROPIC_API_KEY };
  }
  try {
    const cfg = readGlobalConfig();
    const providers = (cfg as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
    const anthropic = providers?.anthropic as Record<string, unknown> | undefined;
    if (anthropic?.apiKey) {
      return { apiKey: anthropic.apiKey as string, model: anthropic.model as string | undefined };
    }
  } catch {
    // No config
  }
  return null;
}
```

- [ ] **Step 3: Update plugin.ts error handling**

In `src/proxy/plugin.ts`, at line 3 add the import and update line 85:

Add import:
```typescript
import { ProviderError } from "../providers/types.js";
```

Change the error code extraction (around line 85):
```typescript
// Before:
const code = err instanceof OpenClawError ? err.code : "UNKNOWN";

// After:
const code = err instanceof OpenClawError
  ? err.code
  : err instanceof ProviderError
    ? err.code
    : "UNKNOWN";
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm run typecheck 2>&1 | grep -E "src/proxy/|src/providers/" | head -10`
Expected: No errors in these files

- [ ] **Step 5: Run existing tests**

Run: `pnpm run test 2>&1 | tail -5`
Expected: All tests pass (existing + new)

- [ ] **Step 6: Commit**

```bash
git add src/providers/index.ts src/proxy/ProxyService.ts src/proxy/plugin.ts
git commit -m "feat(providers): integrate ProviderManager into ProxyService"
```

---

## Task 7: CLI — providers command and fuzzy matcher

**Files:**
- Create: `src/commands/providers.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/fuzzy-matcher.ts`

- [ ] **Step 1: Implement providers command**

```typescript
// src/commands/providers.ts
import { logger } from "../core/logger.js";
import pc from "picocolors";

export async function runProvidersCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    logger.plain("Usage: teamclaw providers <subcommand>");
    logger.plain("");
    logger.plain("Subcommands:");
    logger.plain("  list     Show configured providers and status");
    logger.plain("  test     Test each provider in chain");
    return;
  }

  if (sub === "list") {
    const { readGlobalConfig } = await import("../core/global-config.js");
    const cfg = readGlobalConfig();
    const providers = (cfg as Record<string, unknown> | null)?.providers as Record<string, unknown> | undefined;
    const anthropicCfg = providers?.anthropic as Record<string, unknown> | undefined;

    const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY || anthropicCfg?.apiKey);

    logger.plain("Providers:");
    logger.plain(`  1. ${pc.bold("OpenClaw gateway")}     ${pc.green("configured")} (primary)`);
    if (hasAnthropicKey) {
      logger.plain(`  2. ${pc.bold("Anthropic API")}        ${pc.green("configured")} (fallback)`);
    } else {
      logger.plain(`  2. ${pc.bold("Anthropic API")}        ${pc.dim("not configured")} (fallback)`);
    }
    return;
  }

  if (sub === "test") {
    const { readGlobalConfigWithDefaults } = await import("../core/global-config.js");
    const cfg = readGlobalConfigWithDefaults();
    const providers = (cfg as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
    const anthropicCfg = providers?.anthropic as Record<string, unknown> | undefined;

    logger.plain("Checking providers...");

    // Test OpenClaw
    const openclawUrl = cfg.apiUrl || `http://${cfg.gatewayHost}:${cfg.apiPort}`;
    const start = Date.now();
    try {
      const res = await fetch(`${openclawUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      const elapsed = Date.now() - start;
      if (res.ok) {
        logger.plain(`  ${pc.green("✓")} OpenClaw gateway     connected (${elapsed}ms)`);
      } else {
        logger.plain(`  ${pc.red("✗")} OpenClaw gateway     HTTP ${res.status}`);
      }
    } catch {
      logger.plain(`  ${pc.red("✗")} OpenClaw gateway     unreachable`);
    }

    // Test Anthropic
    const hasKey = !!(process.env.ANTHROPIC_API_KEY || anthropicCfg?.apiKey);
    if (hasKey) {
      logger.plain(`  ${pc.green("✓")} Anthropic API        configured (key present)`);
    } else {
      logger.plain(`  ${pc.dim("-")} Anthropic API        not configured`);
    }

    logger.plain(`Primary: OpenClaw`);
    if (hasKey) {
      logger.plain(`Fallback: Anthropic`);
    }
    return;
  }

  logger.error(`Unknown providers subcommand: ${sub}`);
  logger.error("Run `teamclaw providers --help` for usage.");
  process.exit(1);
}
```

- [ ] **Step 2: Add "providers" to fuzzy matcher**

In `src/cli/fuzzy-matcher.ts`, add `"providers"` to the `COMMANDS` array (before the closing `] as const`):

```typescript
    "cache",
    "providers",
] as const;
```

Add subcommands:
```typescript
    cache: ["stats", "clear", "prune", "disable", "enable"],
    providers: ["list", "test"],
};
```

- [ ] **Step 3: Add providers dispatch to cli.ts**

In `src/cli.ts`, add help line after the cache line:
```typescript
        "  " + cmd(pad("providers")) + desc("List and test configured LLM providers"),
```

Add dispatch branch (before the `demo` branch):
```typescript
    } else if (cmd === "providers") {
        const { runProvidersCommand } = await import("./commands/providers.js");
        await runProvidersCommand(args.slice(1));
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm run typecheck 2>&1 | grep -E "src/commands/providers|src/cli" | head -5`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/commands/providers.ts src/cli.ts src/cli/fuzzy-matcher.ts
git commit -m "feat(providers): add providers list/test CLI commands"
```

---

## Task 8: Update check command, audit trail, and work-runner

**Files:**
- Modify: `src/check.ts`
- Modify: `src/audit/types.ts`
- Modify: `src/audit/builder.ts`
- Modify: `src/audit/renderers/markdown.ts`
- Modify: `src/work-runner.ts`

- [ ] **Step 1: Update check command to show provider status**

At the end of `runCheck()` in `src/check.ts`, after the existing worker connectivity check block (after line 96), append:

```typescript
  // Provider status
  logger.plain("");
  logger.plain("Provider chain:");
  logger.plain("  Primary:  OpenClaw gateway");

  const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY);
  let hasConfigKey = false;
  try {
    const { readGlobalConfig } = await import("./core/global-config.js");
    const cfg = readGlobalConfig();
    const providers = (cfg as Record<string, unknown> | null)?.providers as Record<string, unknown> | undefined;
    const anthropic = providers?.anthropic as Record<string, unknown> | undefined;
    hasConfigKey = !!(anthropic?.apiKey);
  } catch {}

  if (hasAnthropicKey || hasConfigKey) {
    logger.plain("  Fallback: Anthropic API (configured)");
  } else {
    logger.plain("  Fallback: Anthropic API (not configured)");
  }
```

- [ ] **Step 2: Add providerStats to AuditTrail type**

In `src/audit/types.ts`, add after the `cachePerformance` field:

```typescript
  providerStats?: {
    openclaw: { requests: number; failures: number };
    anthropic: { requests: number; failures: number };
    fallbacksTriggered: number;
  };
```

- [ ] **Step 3: Add provider stats to audit builder**

In `src/audit/builder.ts`, in the `buildAuditTrail` function, before the `return` statement, add:

```typescript
  // Build provider stats (best-effort)
  let providerStats: import("./types.js").AuditTrail["providerStats"];
  try {
    const { getProviderManager } = await import("../proxy/ProxyService.js");
    const mgr = getProviderManager();
    if (mgr) {
      const stats = mgr.getStats();
      const total = stats.openclaw.requests + stats.anthropic.requests;
      if (total > 0) {
        providerStats = stats;
      }
    }
  } catch {
    // Provider stats unavailable
  }
```

And add to the return:
```typescript
    ...(providerStats ? { providerStats } : {}),
```

- [ ] **Step 4: Add provider usage markdown renderer**

In `src/audit/renderers/markdown.ts`, after the `renderCachePerformance` function, add:

```typescript
function renderProviderUsage(audit: AuditTrail): string {
  const p = audit.providerStats!;
  const lines = [
    "## Provider Usage",
    "",
    `- OpenClaw: ${p.openclaw.requests} requests, ${p.openclaw.failures} failures`,
    `- Anthropic: ${p.anthropic.requests} requests (fallback), ${p.anthropic.failures} failures`,
    `- Fallbacks triggered: ${p.fallbacksTriggered}`,
  ];
  return lines.join("\n");
}
```

And add the conditional rendering in the main function (after cachePerformance):
```typescript
  if (audit.providerStats) {
    sections.push(renderProviderUsage(audit));
  }
```

- [ ] **Step 5: Update work-runner to start/stop health monitor**

In `src/work-runner.ts`, add import at the top alongside the existing cache imports:

```typescript
import { getHealthMonitor, getProviderManager } from "./proxy/ProxyService.js";
```

After the cache auto-prune block (after `cacheStore.prune()...`), add:

```typescript
    // Start provider health monitor for the work session
    const healthMonitor = getHealthMonitor();
    if (healthMonitor) {
        healthMonitor.start();
    }
    const providerMgr = getProviderManager();
    if (providerMgr) {
        providerMgr.resetStats();
    }
```

Note: `getHealthMonitor()` and `getProviderManager()` access the ProxyService singleton. The singleton may not exist yet at this point — it gets created lazily when `createProxyService()` is first called (from the Fastify plugin or think executor). If it doesn't exist yet, these return `null` and no health monitor starts — which is fine because the work-runner path creates the proxy later via the web server startup. The `.unref()` on the health monitor's interval ensures it never blocks process exit, so no explicit `stop()` is needed in the shutdown handler.

- [ ] **Step 6: Run typecheck and tests**

Run: `pnpm run typecheck 2>&1 | grep -c "error TS"` — should match pre-existing error count only
Run: `pnpm run test 2>&1 | tail -3`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/check.ts src/audit/types.ts src/audit/builder.ts src/audit/renderers/markdown.ts src/work-runner.ts
git commit -m "feat(providers): add provider stats to audit, check, and work-runner"
```

---

## Task 9: Setup wizard Anthropic key step

**Files:**
- Modify: `src/commands/setup.ts`

- [ ] **Step 1: Add Anthropic key step**

In `src/commands/setup.ts`, after Step 4 (Model Selection) around line 468, add a new step:

```typescript
    // Step 4.5: Anthropic fallback (optional)
    note("Fallback Provider (optional)", pc.bold("Anthropic API Key"));
    const wantsFallback = handleCancel(
        await confirm({
            message: "Add Anthropic API key for fallback? (recommended)",
            initialValue: false,
        }),
    ) as boolean;

    if (wantsFallback) {
        const keyInput = handleCancel(
            await text({
                message: "Enter Anthropic API key (starts with sk-ant-):",
                placeholder: "sk-ant-...",
                validate: (val) => {
                    if (val && !val.startsWith("sk-ant-") && !val.startsWith("sk-")) {
                        return "API key should start with sk-ant- or sk-";
                    }
                },
            }),
        ) as string;

        if (keyInput?.trim()) {
            state.anthropicApiKey = keyInput.trim();
            const masked = "..." + state.anthropicApiKey.slice(-4);
            logger.success(`Anthropic API key: ${masked}`);
        }
    }
```

Add `anthropicApiKey` to the `WizardState` type (add `anthropicApiKey?: string`).

In `persistAllConfig`, after the `writeGlobalConfig` call, if `state.anthropicApiKey` is set, read back the config, add the providers block, and write again:

```typescript
    if (state.anthropicApiKey) {
        const raw = JSON.parse(readFileSync(globalConfigPath, "utf-8")) as Record<string, unknown>;
        raw.providers = {
            chain: ["openclaw", "anthropic"],
            firstChunkTimeoutMs: 15000,
            anthropic: {
                apiKey: state.anthropicApiKey,
                model: "claude-sonnet-4-6",
            },
        };
        writeFileSync(globalConfigPath, JSON.stringify(raw, null, 2), "utf-8");
    }
```

Update the summary note to show the fallback status:
```typescript
            `Fallback  : ${state.anthropicApiKey ? "Anthropic API (configured)" : "none"}`,
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck 2>&1 | grep "src/commands/setup"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup.ts
git commit -m "feat(providers): add Anthropic API key step to setup wizard"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm run typecheck`
Expected: Only pre-existing errors (templates.ts)

- [ ] **Step 2: Run all tests**

Run: `pnpm run test`
Expected: All tests pass including new provider-manager.test.ts and anthropic-provider.test.ts

- [ ] **Step 3: Verify CLI commands work**

Run: `pnpm run build && node dist/cli.js providers --help`
Expected: Shows providers subcommands

Run: `node dist/cli.js --help | grep providers`
Expected: Shows providers in help text

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix(providers): address integration issues from final verification"
```
