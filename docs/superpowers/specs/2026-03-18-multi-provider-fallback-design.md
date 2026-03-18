# Multi-Provider Fallback Design

**Date:** 2026-03-18
**Status:** Approved
**Problem:** TeamClaw is entirely dependent on OpenClaw gateway. If OpenClaw is slow, down, or rate-limiting, there is no fallback — the session dies.

## Overview

Implement a provider abstraction layer that tries OpenClaw first, then automatically falls back to the Anthropic API when OpenClaw is unavailable. Fallback is transparent to the user (a warning is shown, but the sprint continues).

## Architecture: ProviderManager inside ProxyService

The ProviderManager replaces `OpenClawClient` as the stream source inside `ProxyService`. Cache interceptor wraps the ProviderManager output. Cache keys use the model from `StreamOptions` as passed by the caller — when fallback occurs, the Anthropic provider uses a different model name, so cross-provider responses produce different cache keys. This is intentional: different models produce different outputs and should not share cache entries.

```
ProxyService.stream()
  -> mock check
  -> providerManager.stream(prompt, options)
    -> try openclaw-provider.stream()
    -> on fallback trigger -> anthropic-provider.stream()
  -> streamWithCache(prompt, model, role, providerStream)
```

## Provider Interface

```typescript
interface StreamProvider {
  name: string;
  stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined>;
  healthCheck(): Promise<boolean>;
  isAvailable(): boolean;
}
```

Both providers yield identical `StreamChunk` objects. The ProviderManager and cache interceptor are provider-agnostic.

## Provider Chain

```typescript
const PROVIDER_CHAIN = ["openclaw", "anthropic"];
```

Configurable via `config.providers.chain`.

## Fallback Triggers

Switch to next provider when:
- Connection fails (ECONNREFUSED, ENOTFOUND) -> OpenClawError `CONNECTION_FAILED`
- 5xx server error -> OpenClawError `STREAM_FAILED` with 5xx status
- 429 rate limit -> OpenClawError `STREAM_FAILED` with 429 status
- First chunk timeout (default 15s) -> OpenClawError `TIMEOUT`

Do NOT fallback on:
- 4xx errors except 429 (user/config error, fallback won't help)
- Slow responses after first chunk arrives

## ProviderError Type

```typescript
class ProviderError extends Error {
  provider: ProviderName;
  code: string;
  statusCode?: number;    // HTTP status when available (e.g. 429, 500)
  isFallbackTrigger: boolean;
}
```

The `isFallbackTrigger` flag drives the ProviderManager's retry-or-rethrow decision.

**HTTP status extraction**: `OpenClawError("STREAM_FAILED", "HTTP 429: ...")` embeds status in the message string, which is fragile. Add an optional `statusCode` field to `OpenClawError` (one-line change in `src/client/errors.ts`) and set it when the client throws on non-OK HTTP responses. The OpenClaw provider reads `err.statusCode` directly instead of parsing the message. This also goes into `ProviderError.statusCode` for consistent downstream access.

## OpenClaw Provider

- Wraps existing `OpenClawClient` — one small change to client: add `statusCode?: number` field to `OpenClawError` (set in `stream()` when HTTP response is non-OK)
- `stream()` delegates to `client.stream()`, catches `OpenClawError`, converts to `ProviderError` with `isFallbackTrigger` set based on `err.code` and `err.statusCode`
- First-chunk timeout: creates a derived `AbortController` with a `setTimeout` for `firstChunkTimeoutMs`. If the caller already provided an `options.signal`, chains it into the derived controller via `options.signal.addEventListener("abort", () => derivedController.abort())` so client disconnects cancel the fetch immediately. Passes `derivedController.signal` into `StreamOptions.signal` when calling `client.stream()`. Once the first chunk is yielded, clears the timer. If the timer fires, the abort signal cancels the underlying `fetch` and its `ReadableStreamDefaultReader`, preventing reader lock leaks. The OpenClaw client already handles `signal` in its `fetch()` call (same pattern at lines 177-182)
- `healthCheck()` does HTTP GET to `/health` (same pattern as `src/check.ts`)
- `isAvailable()` returns a flag set by the health monitor

## Anthropic Provider

- Uses `@anthropic-ai/sdk` (new dependency)
- API key resolution: `ANTHROPIC_API_KEY` env var > `config.providers.anthropic.apiKey` > null (provider unavailable)
- Model: `config.providers.anthropic.model` > `"claude-sonnet-4-6"`
- Native API mapping (option C):
  - `options.systemPrompt` -> Anthropic `system` parameter
  - `prompt` -> `messages: [{ role: "user", content: prompt }]`
  - `content_block_delta` events -> `StreamChunk { content, done: false }`
  - `message_stop` -> `StreamChunk { content: "", done: true, usage }`
- `healthCheck()` validates API key presence + cached last-success timestamp. No token-burning API calls
- `isAvailable()` returns false if no API key configured

## ProviderManager

```typescript
class ProviderManager {
  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined>;
  getStats(): ProviderStats;
  resetStats(): void;
}
```

Fallback logic:
1. Iterate providers in chain order
2. Skip providers where `isAvailable()` is false
3. Try `provider.stream()`. On success, record stat, return
4. On error with `isFallbackTrigger: true`: log warning, record failure, continue to next
5. On error with `isFallbackTrigger: false`: rethrow immediately
6. If all providers exhausted: throw `ProviderError("ALL_PROVIDERS_FAILED")`

Fallback notification: `"OpenClaw unavailable -- switching to Anthropic API"`

Factory: `createProviderManager(config)` builds the chain, only includes anthropic if API key is available.

## Provider Stats

```typescript
type ProviderStats = {
  openclaw: { requests: number; failures: number };
  anthropic: { requests: number; failures: number };
  fallbacksTriggered: number;
};
```

Tracked per session. Exposed via `getStats()` / `resetStats()`.

## Health Monitor

- `setInterval` loop every 30s during active work sessions
- Only pings OpenClaw via HTTP `/health` — Anthropic uses key-presence check (no API calls)
- 2 consecutive failures -> mark provider unavailable
- 1 successful ping -> mark available again
- `start()` / `stop()` lifecycle called from work-runner
- Unavailable providers are skipped immediately by ProviderManager (no timeout wait)
- **Non-work-runner paths** (e.g. `teamclaw think`): health monitor is NOT started. These paths rely purely on reactive fallback (try provider, catch error, try next). The monitor's `setInterval` uses `.unref()` as a safety net so it never blocks process exit even if `stop()` is not called

## ProxyService Integration

Minimal change — replace `OpenClawClient` with `ProviderManager`:
- `createProxyService()` factory still accepts `OpenClawClientConfig` for backward compatibility — it builds a `ProviderManager` internally from the config. This preserves the call sites in `src/proxy/plugin.ts` and `src/think/executor.ts` without changes to their code
- `stream()` calls `this.providerManager.stream()` instead of `this.client.stream()`
- `ensureConnected()` removed — connection handled per-provider inside the manager
- `reconnect()` resets health monitor state for all providers and marks them available, allowing fresh fallback attempts. The Fastify plugin endpoint continues to work
- Mock mode unchanged
- Cache interceptor unchanged — wraps ProviderManager output identically

## Config

```json
{
  "providers": {
    "chain": ["openclaw", "anthropic"],
    "firstChunkTimeoutMs": 15000,
    "anthropic": {
      "apiKey": "sk-ant-...",
      "model": "claude-sonnet-4-6"
    }
  }
}
```

Read from raw config JSON at ProviderManager construction time.

## CLI

### `teamclaw providers list`
```
Providers:
  1. OpenClaw gateway     available (primary)
  2. Anthropic API        available (fallback)
```

### `teamclaw providers test`
```
Checking providers...
  OpenClaw gateway     connected (42ms)
  Anthropic API        configured (key present)
Primary: OpenClaw
Fallback: Anthropic
```

### `teamclaw check` update
Append provider status section after existing worker connectivity check.

## Setup Wizard

New optional step after model selection:
- "Add Anthropic API key for fallback? (recommended)"
- Key stored in `providers.anthropic.apiKey`
- Key masked in display (last 4 chars)
- Skip = OpenClaw-only mode (same as today)

## Audit Trail

New `providerStats` section in `AuditTrail`:
```markdown
## Provider Usage
- OpenClaw: 45 requests, 2 failures
- Anthropic: 3 requests (fallback), 0 failures
- Fallbacks triggered: 2
```

## File Structure

New files:
- `src/providers/provider.ts` — StreamProvider interface
- `src/providers/openclaw-provider.ts` — OpenClaw implementation
- `src/providers/anthropic-provider.ts` — Anthropic implementation
- `src/providers/provider-manager.ts` — fallback chain logic
- `src/providers/health-monitor.ts` — background health checks
- `src/providers/types.ts` — ProviderName, ProviderError, ProviderStats
- `src/providers/index.ts` — barrel export
- `src/commands/providers.ts` — list/test subcommands
- `tests/provider-manager.test.ts` — fallback chain tests
- `tests/anthropic-provider.test.ts` — Anthropic SDK mapping tests

Modified files:
- `src/client/errors.ts` — add optional `statusCode` field to `OpenClawError`
- `src/client/OpenClawClient.ts` — set `statusCode` on error when HTTP response is non-OK
- `src/proxy/ProxyService.ts` — use ProviderManager (factory still accepts `OpenClawClientConfig`)
- `src/proxy/plugin.ts` — handle `ProviderError` in addition to `OpenClawError` in error code extraction (the `instanceof` check at the SSE error handler)
- `src/check.ts` — add provider status section
- `src/commands/setup.ts` — Anthropic key step
- `src/cli.ts` — dispatch providers command, help text
- `src/cli/fuzzy-matcher.ts` — add providers + subcommands
- `src/audit/builder.ts` — provider stats section
- `src/audit/types.ts` — providerStats field
- `src/audit/renderers/markdown.ts` — render provider usage
- `src/work-runner.ts` — start/stop health monitor

## Test Coverage

### provider-manager.test.ts
- Tries OpenClaw first on success
- Switches to Anthropic on ECONNREFUSED
- Switches on first-chunk timeout
- Does NOT switch on 4xx (except 429)
- Switches on 429
- Throws ProviderError when all providers fail
- Skips unavailable providers immediately
- Stats track requests/failures/fallbacks correctly

### anthropic-provider.test.ts
- Maps prompt to Anthropic messages format
- Maps systemPrompt to system parameter
- Yields StreamChunk from content_block_delta events
- Returns usage stats on final chunk
- ANTHROPIC_API_KEY env var takes precedence over config
- isAvailable() returns false when no key configured

## What NOT to Do

- Do not change `/proxy/stream` endpoint interface
- Do not change cache interceptor logic
- Do not require Anthropic API key — optional fallback
- Do not fallback mid-stream — only before first chunk
- Do not modify LangGraph graph nodes
- Do not modify replay mode
- Do not make health check API calls to Anthropic (token cost)
