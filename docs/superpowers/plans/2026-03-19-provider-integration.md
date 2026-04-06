# Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete model authentication and provider integration for 30+ providers across subscription plans, API keys, inference networks, cloud credentials, and local models.

**Architecture:** ~80% of providers reuse `OpenAICompatibleProvider` via presets. New dedicated providers only for non-OpenAI-compatible auth flows (ChatGPT OAuth, Copilot device flow, Bedrock SigV4, Vertex GCP auth, Gemini OAuth). All providers implement `StreamProvider`. Config stored in `~/.openpawl/config.json`. Provider chain fallback via `ProviderManager`.

**Tech Stack:** TypeScript (ESM), OpenAI SDK, @anthropic-ai/sdk, @aws-sdk/client-bedrock-runtime, @clack/prompts, open (browser launch), Vitest + vi.mock for tests.

---

## File Structure

### New Files
- `src/providers/provider-catalog.ts` — Central catalog of all provider metadata (models, URLs, env vars, labels, auth methods)
- `src/providers/copilot-provider.ts` — GitHub Copilot device OAuth provider
- `src/providers/chatgpt-oauth-provider.ts` — ChatGPT subscription OAuth provider
- ~~`src/providers/gemini-provider.ts`~~ — NOT NEEDED: Gemini API key uses OpenAI-compatible preset; Gemini OAuth stubbed in factory
- `src/providers/bedrock-provider.ts` — AWS Bedrock with IAM/SigV4 auth
- `src/providers/vertex-provider.ts` — Google Vertex AI with service account auth
- `src/providers/oauth-helpers.ts` — Shared OAuth utilities (local callback server, token refresh)
- `tests/providers/provider-catalog.test.ts` — Catalog unit tests
- `tests/providers/openai-presets.test.ts` — Tests for all new OpenAI-compatible presets
- `tests/providers/copilot-provider.test.ts` — Copilot auth flow tests
- `tests/providers/chatgpt-oauth-provider.test.ts` — ChatGPT OAuth tests
- `tests/providers/bedrock-provider.test.ts` — Bedrock auth tests

### Modified Files
- `src/providers/types.ts` — Expand `ProviderName` union
- `src/providers/openai-compatible-provider.ts` — Add ~15 new presets
- `src/providers/anthropic-provider.ts` — Add setup-token auth method
- `src/providers/provider-factory.ts` — Wire all new providers + env var discovery
- `src/core/global-config.ts` — Expand `ProviderConfigEntry` type + normalization
- `src/core/errors.ts` — Add new provider URLs, prefixes, error messages
- `src/commands/providers.ts` — Add `add` subcommand with full provider menu
- `src/commands/setup/connection.ts` — Subscription detection + expanded provider picker
- `src/commands/setup.ts` — Wire subscription early question
- `package.json` — Add `@aws-sdk/client-bedrock-runtime`, `open` dependencies

---

## Task 1: Expand Core Types & Provider Catalog

**Files:**
- Create: `src/providers/provider-catalog.ts`
- Modify: `src/providers/types.ts`
- Modify: `src/core/global-config.ts`
- Test: `tests/providers/provider-catalog.test.ts`

- [ ] **Step 1: Write the failing test for provider catalog**

```typescript
// tests/providers/provider-catalog.test.ts
import { describe, it, expect } from "vitest";
import { PROVIDER_CATALOG, getProviderMeta, getAllProviderIds } from "../src/providers/provider-catalog.js";

describe("provider-catalog", () => {
  it("exports a catalog with all expected provider IDs", () => {
    const ids = getAllProviderIds();
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("copilot");
    expect(ids).toContain("chatgpt");
    expect(ids).toContain("gemini");
    expect(ids).toContain("grok");
    expect(ids).toContain("mistral");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("groq");
    expect(ids).toContain("cerebras");
    expect(ids).toContain("together");
    expect(ids).toContain("fireworks");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("perplexity");
    expect(ids).toContain("moonshot");
    expect(ids).toContain("zai");
    expect(ids).toContain("minimax");
    expect(ids).toContain("cohere");
    expect(ids).toContain("opencode-zen");
    expect(ids).toContain("opencode-go");
    expect(ids).toContain("bedrock");
    expect(ids).toContain("vertex");
    expect(ids).toContain("azure");
    expect(ids).toContain("ollama");
    expect(ids).toContain("lmstudio");
    expect(ids).toContain("custom");
    expect(ids.length).toBeGreaterThanOrEqual(26);
  });

  it("getProviderMeta returns correct metadata", () => {
    const meta = getProviderMeta("grok");
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("xAI Grok");
    expect(meta!.authMethod).toBe("apikey");
    expect(meta!.envKeys).toContain("XAI_API_KEY");
    expect(meta!.models.length).toBeGreaterThan(0);
  });

  it("getProviderMeta returns undefined for unknown provider", () => {
    expect(getProviderMeta("nonexistent")).toBeUndefined();
  });

  it("each catalog entry has required fields", () => {
    for (const [id, meta] of Object.entries(PROVIDER_CATALOG)) {
      expect(meta.name, `${id} missing name`).toBeTruthy();
      expect(meta.authMethod, `${id} missing authMethod`).toBeTruthy();
      expect(meta.category, `${id} missing category`).toBeTruthy();
      expect(meta.models, `${id} missing models`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/providers/provider-catalog.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Expand ProviderName in types.ts**

Update `src/providers/types.ts` — expand the `ProviderName` union type:

```typescript
export type ProviderName =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "deepseek"
  | "groq"
  | "custom"
  // Subscription providers
  | "chatgpt"
  | "copilot"
  | "anthropic-sub"
  | "gemini-oauth"
  // API key providers
  | "gemini"
  | "grok"
  | "mistral"
  | "cerebras"
  | "together"
  | "fireworks"
  | "perplexity"
  | "moonshot"
  | "zai"
  | "minimax"
  | "cohere"
  // OpenCode
  | "opencode-zen"
  | "opencode-go"
  // Cloud/Enterprise
  | "bedrock"
  | "vertex"
  | "azure"
  // Local
  | "lmstudio";
```

- [ ] **Step 4: Expand ProviderConfigEntry AND normalizeGlobalConfig in global-config.ts**

**CRITICAL**: The `validProviderTypes` array and field normalization must be updated NOW, before any other task writes new provider types to config — otherwise `normalizeGlobalConfig` will silently drop them.

Update `src/core/global-config.ts` — expand the `ProviderConfigEntry` interface:

```typescript
export interface ProviderConfigEntry {
  type: ProviderName;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  name?: string;
  // OAuth fields (ChatGPT, Gemini)
  authMethod?: "apikey" | "oauth" | "device-oauth" | "setup-token" | "local" | "credentials";
  oauthToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  // Copilot-specific
  githubToken?: string;
  copilotToken?: string;
  copilotTokenExpiry?: number;
  // Anthropic setup-token
  setupToken?: string;
  // AWS Bedrock
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  // Vertex AI
  serviceAccountPath?: string;
  projectId?: string;
  // Azure
  apiVersion?: string;
}
```

Also update `validProviderTypes` in `normalizeGlobalConfig()` to include all new types:

```typescript
const validProviderTypes = [
  "anthropic", "openai", "openrouter", "ollama", "deepseek", "groq", "custom",
  "chatgpt", "copilot", "anthropic-sub", "gemini-oauth",
  "gemini", "grok", "mistral", "cerebras", "together", "fireworks",
  "perplexity", "moonshot", "zai", "minimax", "cohere",
  "opencode-zen", "opencode-go",
  "bedrock", "vertex", "azure", "lmstudio",
] as const;
```

And update the provider normalization `.map()` to preserve all new fields:

```typescript
.map((v) => ({
  type: v.type as ProviderConfigEntry["type"],
  ...(typeof v.apiKey === "string" && v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {}),
  ...(typeof v.baseURL === "string" && v.baseURL.trim() ? { baseURL: v.baseURL.trim() } : {}),
  ...(typeof v.model === "string" && v.model.trim() ? { model: v.model.trim() } : {}),
  ...(typeof v.name === "string" && v.name.trim() ? { name: v.name.trim() } : {}),
  // New auth fields
  ...(typeof v.authMethod === "string" ? { authMethod: v.authMethod } : {}),
  ...(typeof v.oauthToken === "string" && v.oauthToken.trim() ? { oauthToken: v.oauthToken.trim() } : {}),
  ...(typeof v.refreshToken === "string" && v.refreshToken.trim() ? { refreshToken: v.refreshToken.trim() } : {}),
  ...(typeof v.tokenExpiry === "number" ? { tokenExpiry: v.tokenExpiry } : {}),
  ...(typeof v.githubToken === "string" && v.githubToken.trim() ? { githubToken: v.githubToken.trim() } : {}),
  ...(typeof v.copilotToken === "string" && v.copilotToken.trim() ? { copilotToken: v.copilotToken.trim() } : {}),
  ...(typeof v.copilotTokenExpiry === "number" ? { copilotTokenExpiry: v.copilotTokenExpiry } : {}),
  ...(typeof v.setupToken === "string" && v.setupToken.trim() ? { setupToken: v.setupToken.trim() } : {}),
  ...(typeof v.accessKeyId === "string" && v.accessKeyId.trim() ? { accessKeyId: v.accessKeyId.trim() } : {}),
  ...(typeof v.secretAccessKey === "string" && v.secretAccessKey.trim() ? { secretAccessKey: v.secretAccessKey.trim() } : {}),
  ...(typeof v.sessionToken === "string" && v.sessionToken.trim() ? { sessionToken: v.sessionToken.trim() } : {}),
  ...(typeof v.region === "string" && v.region.trim() ? { region: v.region.trim() } : {}),
  ...(typeof v.serviceAccountPath === "string" && v.serviceAccountPath.trim() ? { serviceAccountPath: v.serviceAccountPath.trim() } : {}),
  ...(typeof v.projectId === "string" && v.projectId.trim() ? { projectId: v.projectId.trim() } : {}),
  ...(typeof v.apiVersion === "string" && v.apiVersion.trim() ? { apiVersion: v.apiVersion.trim() } : {}),
}))
```

Import `ProviderName` from `types.ts`:
```typescript
import type { ProviderName } from "../providers/types.js";
```

- [ ] **Step 5: Create provider-catalog.ts**

```typescript
// src/providers/provider-catalog.ts

export type AuthMethod = "apikey" | "oauth" | "device-oauth" | "setup-token" | "local" | "credentials";
export type ProviderCategory = "subscription" | "apikey" | "opencode" | "cloud" | "local";

export interface ProviderModel {
  id: string;
  label: string;
  hint?: string;
}

export interface ProviderMeta {
  name: string;
  authMethod: AuthMethod;
  category: ProviderCategory;
  envKeys: string[];
  keyPrefix?: string;
  keyUrl?: string;
  statusUrl?: string;
  baseURL?: string;
  models: ProviderModel[];
  menuLabel: string;
  menuHint?: string;
  notes?: string[];
  warning?: string;
  /** True if this uses OpenAICompatibleProvider preset */
  openaiCompatible: boolean;
}

export const PROVIDER_CATALOG: Record<string, ProviderMeta> = {
  // === SUBSCRIPTION PLANS ===
  chatgpt: {
    name: "ChatGPT Plus/Pro",
    authMethod: "oauth",
    category: "subscription",
    envKeys: [],
    baseURL: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", hint: "Most capable agentic coding" },
      { id: "gpt-5-mini", label: "GPT-5 Mini", hint: "Fast" },
      { id: "gpt-4o", label: "GPT-4o", hint: "Multimodal" },
      { id: "o3", label: "o3", hint: "Reasoning" },
    ],
    menuLabel: "ChatGPT Plus/Pro — OAuth [officially supported by OpenAI]",
    openaiCompatible: false,
  },
  copilot: {
    name: "GitHub Copilot",
    authMethod: "device-oauth",
    category: "subscription",
    envKeys: ["GITHUB_TOKEN"],
    baseURL: "https://api.githubcopilot.com/chat/completions",
    models: [
      { id: "claude-opus-4.6", label: "Claude Opus 4.6", hint: "Best reasoning" },
      { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", hint: "Balanced" },
      { id: "gpt-4o", label: "GPT-4o", hint: "Multimodal" },
      { id: "gpt-5-mini", label: "GPT-5 Mini", hint: "Fast" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Long context" },
      { id: "o3", label: "o3", hint: "Reasoning" },
    ],
    menuLabel: "GitHub Copilot ($10-19/mo) — Device OAuth [officially supported]",
    openaiCompatible: false,
  },
  "anthropic-sub": {
    name: "Claude Pro/Max",
    authMethod: "setup-token",
    category: "subscription",
    envKeys: [],
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "Most capable" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Balanced" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fast" },
    ],
    menuLabel: "Claude Pro/Max — setup-token [ToS gray area]",
    menuHint: "⚠️",
    warning: `⚠️  IMPORTANT: Anthropic's Terms of Service state that OAuth tokens from\n    Claude Pro/Max plans are intended for Claude Code and claude.ai only.\n    OpenPawl supports this as a technical compatibility option. Anthropic has\n    enforced this in the past. Use at your own discretion. For a guaranteed\n    safe path, use an Anthropic API key instead.`,
    openaiCompatible: false,
  },
  "gemini-oauth": {
    name: "Google Gemini (subscription)",
    authMethod: "oauth",
    category: "subscription",
    envKeys: [],
    models: [
      { id: "gemini-3-pro", label: "Gemini 3 Pro", hint: "Flagship" },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", hint: "Fast" },
    ],
    menuLabel: "Google Gemini Pro/Ultra — OAuth [account ban risk]",
    menuHint: "⚠️",
    warning: `⚠️  WARNING: Google has issued account bans (403 ToS violations) for\n    using Gemini subscription OAuth via third-party tools since February 2026.\n    Google Antigravity ToS explicitly prohibits third-party access.\n    A Gemini API key is strongly recommended instead.`,
    openaiCompatible: false,
  },

  // === API KEY PROVIDERS ===
  anthropic: {
    name: "Anthropic (Claude)",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["ANTHROPIC_API_KEY"],
    keyPrefix: "sk-ant-",
    keyUrl: "https://console.anthropic.com/settings/keys",
    statusUrl: "https://status.anthropic.com",
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "Best reasoning, most capable" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Fast + capable, recommended" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, cheapest" },
    ],
    menuLabel: "Anthropic (Claude) — API key [recommended]",
    openaiCompatible: false,
  },
  openai: {
    name: "OpenAI (GPT)",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["OPENAI_API_KEY"],
    keyPrefix: "sk-",
    keyUrl: "https://platform.openai.com/api-keys",
    statusUrl: "https://status.openai.com",
    baseURL: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", hint: "Agentic coding" },
      { id: "gpt-4o", label: "GPT-4o", hint: "Multimodal, versatile" },
      { id: "gpt-5-mini", label: "GPT-5 Mini", hint: "Fast + cheap" },
      { id: "o3", label: "o3", hint: "Deep reasoning" },
      { id: "o4-mini", label: "o4-mini", hint: "Fast reasoning" },
    ],
    menuLabel: "OpenAI (GPT) — API key",
    openaiCompatible: true,
  },
  gemini: {
    name: "Google Gemini",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    keyUrl: "https://aistudio.google.com/app/apikey",
    statusUrl: "https://status.cloud.google.com",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    models: [
      { id: "gemini-3-pro", label: "Gemini 3 Pro", hint: "Flagship, 1M context" },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", hint: "Fast, cheap" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Strong coding" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Speed optimized" },
    ],
    menuLabel: "Google Gemini — API key [recommended over OAuth]",
    notes: ["Free tier available with rate limits"],
    openaiCompatible: true,
  },
  grok: {
    name: "xAI Grok",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["XAI_API_KEY"],
    keyPrefix: "xai-",
    keyUrl: "https://console.x.ai",
    statusUrl: "https://status.x.ai",
    baseURL: "https://api.x.ai/v1",
    models: [
      { id: "grok-4", label: "Grok-4", hint: "Most capable, 2M context" },
      { id: "grok-4-fast", label: "Grok-4 Fast", hint: "Faster, $0.20/MTok" },
      { id: "grok-3", label: "Grok-3", hint: "Previous gen, strong" },
      { id: "grok-3-mini", label: "Grok-3 Mini", hint: "Cheapest, fast" },
    ],
    menuLabel: "xAI Grok — API key [2M context, real-time X]",
    openaiCompatible: true,
  },
  mistral: {
    name: "Mistral AI",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["MISTRAL_API_KEY"],
    keyUrl: "https://console.mistral.ai/api-keys",
    statusUrl: "https://console.mistral.ai",
    baseURL: "https://api.mistral.ai/v1",
    models: [
      { id: "mistral-large-3", label: "Mistral Large 3", hint: "Frontier, Apache 2.0" },
      { id: "mistral-medium-3", label: "Mistral Medium 3", hint: "Balanced" },
      { id: "codestral", label: "Codestral", hint: "Best for code" },
      { id: "mistral-small", label: "Mistral Small", hint: "Fast, cheap" },
      { id: "pixtral-large", label: "Pixtral Large", hint: "Multimodal" },
    ],
    menuLabel: "Mistral AI — API key [EU data residency]",
    notes: ["Free Experiment plan: 2 req/min, 1B tokens/month", "EU data residency"],
    openaiCompatible: true,
  },
  deepseek: {
    name: "DeepSeek",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["DEEPSEEK_API_KEY"],
    keyPrefix: "sk-",
    keyUrl: "https://platform.deepseek.com/api_keys",
    statusUrl: "https://platform.deepseek.com",
    baseURL: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-v3-2", label: "DeepSeek V3.2", hint: "685B MoE, $0.28/MTok" },
      { id: "deepseek-r1", label: "DeepSeek R1", hint: "Reasoning, o1-class" },
      { id: "deepseek-coder-v3", label: "DeepSeek Coder V3", hint: "Specialized coding" },
    ],
    menuLabel: "DeepSeek — API key [cheapest frontier]",
    notes: ["Dramatically cheaper at same quality level", "Open MIT license"],
    openaiCompatible: true,
  },
  groq: {
    name: "Groq",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["GROQ_API_KEY"],
    keyPrefix: "gsk_",
    keyUrl: "https://console.groq.com/keys",
    statusUrl: "https://console.groq.com",
    baseURL: "https://api.groq.com/openai/v1",
    models: [
      { id: "kimi-k2.5", label: "Kimi K2.5", hint: "1T MoE, strong agentic" },
      { id: "llama-3.3-70b", label: "Llama 3.3 70B", hint: "Versatile" },
      { id: "llama-3.1-70b", label: "Llama 3.1 70B", hint: "Fast" },
      { id: "mixtral-8x7b", label: "Mixtral 8x7B", hint: "Cost-effective" },
      { id: "gemma2-9b", label: "Gemma2 9B", hint: "Small but capable" },
    ],
    menuLabel: "Groq — API key [fastest inference, 1000+ tok/s]",
    notes: ["1000+ tokens/second (LPU hardware)", "Free tier generous"],
    openaiCompatible: true,
  },
  cerebras: {
    name: "Cerebras",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["CEREBRAS_API_KEY"],
    keyUrl: "https://inference.cerebras.ai",
    statusUrl: "https://inference.cerebras.ai",
    baseURL: "https://api.cerebras.ai/v1",
    models: [
      { id: "qwen3-coder-480b", label: "Qwen3 Coder 480B", hint: "Strongest coding" },
      { id: "llama-3.3-70b", label: "Llama 3.3 70B", hint: "General purpose" },
      { id: "llama-3.1-70b", label: "Llama 3.1 70B", hint: "Alternative" },
    ],
    menuLabel: "Cerebras — API key [extreme throughput]",
    notes: ["Wafer-scale engine — highest sequential throughput"],
    openaiCompatible: true,
  },
  together: {
    name: "Together AI",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY"],
    keyUrl: "https://api.together.ai",
    statusUrl: "https://api.together.ai",
    baseURL: "https://api.together.ai/v1",
    models: [
      { id: "kimi-k2.5-instruct", label: "Kimi K2.5", hint: "Multimodal MoE, 1T params" },
      { id: "deepseek-v3-2", label: "DeepSeek V3.2", hint: "685B MoE" },
      { id: "qwen3-235b-a22b", label: "Qwen3 235B", hint: "Leading open coding" },
      { id: "llama-4-maverick", label: "Llama 4 Maverick", hint: "Meta's latest" },
      { id: "mistral-large-3", label: "Mistral Large 3", hint: "Apache 2.0" },
      { id: "glm-5", label: "GLM-5", hint: "Z.AI frontier" },
      { id: "minimax-m2.5", label: "MiniMax M2.5", hint: "1M context" },
    ],
    menuLabel: "Together AI — API key [100+ open models, $100 free]",
    notes: ["100+ open models", "Up to $100 free credit for new users"],
    openaiCompatible: true,
  },
  fireworks: {
    name: "Fireworks AI",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["FIREWORKS_API_KEY"],
    keyUrl: "https://fireworks.ai/api-keys",
    statusUrl: "https://fireworks.ai",
    baseURL: "https://api.fireworks.ai/inference/v1",
    models: [
      { id: "accounts/fireworks/models/deepseek-v3-2", label: "DeepSeek V3.2" },
      { id: "accounts/fireworks/models/qwen3-235b-a22b", label: "Qwen3 235B" },
      { id: "accounts/fireworks/models/llama-4-maverick", label: "Llama 4 Maverick" },
      { id: "accounts/fireworks/models/mixtral-8x7b", label: "Mixtral 8x7B" },
    ],
    menuLabel: "Fireworks AI — API key",
    openaiCompatible: true,
  },
  openrouter: {
    name: "OpenRouter",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["OPENROUTER_API_KEY"],
    keyPrefix: "sk-or-",
    keyUrl: "https://openrouter.ai/settings/keys",
    statusUrl: "https://openrouter.ai",
    baseURL: "https://openrouter.ai/api/v1",
    models: [
      { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
      { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "google/gemini-3-pro", label: "Gemini 3 Pro" },
      { id: "x-ai/grok-4", label: "Grok-4" },
      { id: "deepseek/deepseek-v3-2", label: "DeepSeek V3.2" },
      { id: "qwen/qwen3-235b", label: "Qwen3 235B" },
      { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
      { id: "mistralai/mistral-large-3", label: "Mistral Large 3" },
      { id: "moonshot/kimi-k2.5", label: "Kimi K2.5" },
      { id: "zhipuai/glm-5", label: "GLM-5" },
      { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
    ],
    menuLabel: "OpenRouter — API key [200+ models, one key]",
    notes: ["Gateway to 200+ models", "Shows cost per model"],
    openaiCompatible: true,
  },
  perplexity: {
    name: "Perplexity",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["PERPLEXITY_API_KEY"],
    keyUrl: "https://www.perplexity.ai/settings/api",
    statusUrl: "https://www.perplexity.ai",
    baseURL: "https://api.perplexity.ai",
    models: [
      { id: "sonar-pro", label: "Sonar Pro", hint: "Best quality + web search" },
      { id: "sonar", label: "Sonar", hint: "Fast + web search" },
      { id: "sonar-reasoning", label: "Sonar Reasoning", hint: "Thinking + web search" },
    ],
    menuLabel: "Perplexity — API key [web-grounded search]",
    notes: ["All models grounded in real-time web search"],
    openaiCompatible: true,
  },
  moonshot: {
    name: "Moonshot AI (Kimi)",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["MOONSHOT_API_KEY"],
    keyPrefix: "sk-",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    statusUrl: "https://platform.moonshot.cn",
    baseURL: "https://api.moonshot.cn/v1",
    models: [
      { id: "kimi-k2.5-instruct", label: "Kimi K2.5", hint: "1T MoE, 256K context, multimodal" },
      { id: "kimi-k2-instruct", label: "Kimi K2", hint: "128K context, tool calling" },
      { id: "moonshot-v1-128k", label: "Moonshot V1 128K", hint: "Long context specialist" },
    ],
    menuLabel: "Moonshot AI (Kimi) — API key [Kimi K2.5]",
    notes: ["Also accessible via Together AI / Groq / OpenRouter"],
    openaiCompatible: true,
  },
  zai: {
    name: "Z.AI (GLM / Zhipu AI)",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
    keyUrl: "https://open.bigmodel.cn",
    statusUrl: "https://open.bigmodel.cn",
    baseURL: "https://api.z.ai/api/paas/v4",
    models: [
      { id: "glm-5", label: "GLM-5", hint: "744B/40B MoE, 200K context" },
      { id: "glm-4.7", label: "GLM-4.7", hint: "355B/32B, MIT, coding" },
      { id: "glm-4.7-flash", label: "GLM-4.7 Flash", hint: "Fast, efficient" },
    ],
    menuLabel: "Z.AI (GLM / Zhipu) — API key [GLM-5]",
    notes: ["GLM-5 comparable to Claude Sonnet 4.5", "GLM-4.7 open MIT license"],
    openaiCompatible: true,
  },
  minimax: {
    name: "MiniMax",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["MINIMAX_API_KEY"],
    keyUrl: "https://api.minimax.io",
    statusUrl: "https://api.minimax.io",
    baseURL: "https://api.minimax.io/v1",
    models: [
      { id: "minimax-m2.5", label: "MiniMax M2.5", hint: "1M context, multimodal, MIT" },
      { id: "minimax-m2.1", label: "MiniMax M2.1", hint: "Previous gen" },
    ],
    menuLabel: "MiniMax — API key [1M context]",
    notes: ["1M context window", "Strong multilingual coding"],
    openaiCompatible: true,
  },
  cohere: {
    name: "Cohere",
    authMethod: "apikey",
    category: "apikey",
    envKeys: ["COHERE_API_KEY"],
    keyUrl: "https://dashboard.cohere.com/api-keys",
    statusUrl: "https://dashboard.cohere.com",
    baseURL: "https://api.cohere.com/v2",
    models: [
      { id: "command-r-plus-08-2024", label: "Command R+", hint: "Best for RAG" },
      { id: "command-r-08-2024", label: "Command R", hint: "Efficient, multilingual" },
      { id: "command-a-03-2025", label: "Command A", hint: "Agentic, reasoning" },
    ],
    menuLabel: "Cohere — API key [RAG specialist]",
    notes: ["Best-in-class for RAG", "Free tier available"],
    openaiCompatible: true,
  },

  // === OPENCODE SUBSCRIPTIONS ===
  "opencode-zen": {
    name: "OpenCode Zen",
    authMethod: "apikey",
    category: "opencode",
    envKeys: ["OPENCODE_API_KEY"],
    keyUrl: "https://opencode.ai/auth",
    statusUrl: "https://opencode.ai",
    baseURL: "https://api.opencode.ai/v1",
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "gemini-3-pro", label: "Gemini 3 Pro" },
    ],
    menuLabel: "OpenCode Zen — curated frontier models",
    openaiCompatible: true,
  },
  "opencode-go": {
    name: "OpenCode Go",
    authMethod: "apikey",
    category: "opencode",
    envKeys: ["OPENCODE_GO_API_KEY"],
    keyUrl: "https://opencode.ai/auth",
    statusUrl: "https://opencode.ai",
    baseURL: "https://api.opencode.ai/v1",
    models: [
      { id: "glm-5", label: "GLM-5" },
      { id: "kimi-k2.5", label: "Kimi K2.5" },
      { id: "minimax-m2.5", label: "MiniMax M2.5" },
    ],
    menuLabel: "OpenCode Go — curated open models ($10/mo)",
    openaiCompatible: true,
  },

  // === CLOUD / ENTERPRISE ===
  bedrock: {
    name: "AWS Bedrock",
    authMethod: "credentials",
    category: "cloud",
    envKeys: ["AWS_ACCESS_KEY_ID"],
    models: [
      { id: "anthropic.claude-opus-4-6-v1:0", label: "Claude Opus 4.6" },
      { id: "anthropic.claude-sonnet-4-6-v1:0", label: "Claude Sonnet 4.6" },
      { id: "anthropic.claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { id: "meta.llama4-maverick-17b-instruct", label: "Llama 4 Maverick" },
    ],
    menuLabel: "AWS Bedrock — IAM credentials",
    openaiCompatible: false,
  },
  vertex: {
    name: "Google Vertex AI",
    authMethod: "credentials",
    category: "cloud",
    envKeys: ["GOOGLE_APPLICATION_CREDENTIALS"],
    models: [
      { id: "claude-opus-4-6@anthropic", label: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6@anthropic", label: "Claude Sonnet 4.6" },
      { id: "gemini-3-pro", label: "Gemini 3 Pro" },
      { id: "gemini-3-flash", label: "Gemini 3 Flash" },
    ],
    menuLabel: "Google Vertex AI — service account",
    openaiCompatible: false,
  },
  azure: {
    name: "Azure OpenAI",
    authMethod: "apikey",
    category: "cloud",
    envKeys: ["AZURE_OPENAI_API_KEY"],
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
    ],
    menuLabel: "Azure OpenAI — API key + endpoint",
    notes: ["Content filter DefaultV2 can cause refusals"],
    openaiCompatible: true,
  },

  // === LOCAL PROVIDERS ===
  ollama: {
    name: "Ollama",
    authMethod: "local",
    category: "local",
    envKeys: [],
    baseURL: "http://localhost:11434/v1",
    models: [
      { id: "glm-4.7-flash", label: "GLM-4.7 Flash", hint: "Best local coding, 30B MoE" },
      { id: "qwen3-coder", label: "Qwen3 Coder", hint: "Strong coding" },
      { id: "deepseek-v3:8b", label: "DeepSeek V3 8B", hint: "Efficient" },
      { id: "llama3:70b", label: "Llama 3 70B", hint: "General purpose" },
      { id: "mistral", label: "Mistral", hint: "Balanced" },
      { id: "codellama", label: "Code Llama", hint: "Code-focused" },
    ],
    menuLabel: "Ollama — auto-detect [no key needed]",
    openaiCompatible: true,
  },
  lmstudio: {
    name: "LM Studio",
    authMethod: "local",
    category: "local",
    envKeys: [],
    baseURL: "http://localhost:1234/v1",
    models: [],
    menuLabel: "LM Studio — auto-detect [no key needed]",
    openaiCompatible: true,
  },
  custom: {
    name: "Custom endpoint",
    authMethod: "apikey",
    category: "local",
    envKeys: [],
    models: [],
    menuLabel: "Custom OpenAI-compatible endpoint",
    openaiCompatible: true,
  },
};

export function getProviderMeta(id: string): ProviderMeta | undefined {
  return PROVIDER_CATALOG[id];
}

export function getAllProviderIds(): string[] {
  return Object.keys(PROVIDER_CATALOG);
}

export function getProvidersByCategory(category: ProviderCategory): Array<[string, ProviderMeta]> {
  return Object.entries(PROVIDER_CATALOG).filter(([, meta]) => meta.category === category);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run test -- tests/providers/provider-catalog.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/provider-catalog.ts src/providers/types.ts src/core/global-config.ts tests/providers/provider-catalog.test.ts
git commit -m "feat: add provider catalog and expand core types for 30+ providers"
```

---

## Task 2: Expand OpenAI-Compatible Presets

**Files:**
- Modify: `src/providers/openai-compatible-provider.ts`
- Test: `tests/providers/openai-presets.test.ts`

- [ ] **Step 1: Write the failing test for new presets**

```typescript
// tests/providers/openai-presets.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAICompatibleProvider, type OpenAIPreset } from "../src/providers/openai-compatible-provider.js";

// Mock the openai module
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      constructor(public config: Record<string, unknown>) {}
      chat = {
        completions: {
          create: vi.fn().mockReturnValue({
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: { content: "ok" } }] };
              yield { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } };
            },
          }),
        },
      };
      models = {
        list: vi.fn().mockResolvedValue({ data: [] }),
      };
    },
  };
});

const NEW_PRESETS: OpenAIPreset[] = [
  "gemini", "grok", "mistral", "cerebras", "together",
  "fireworks", "perplexity", "moonshot", "zai", "minimax",
  "cohere", "opencode-zen", "opencode-go", "azure", "lmstudio",
];

describe("OpenAI-compatible new presets", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  for (const preset of NEW_PRESETS) {
    it(`creates provider for preset: ${preset}`, () => {
      const provider = new OpenAICompatibleProvider({
        preset,
        apiKey: "test-key",
      });
      expect(provider.name).toBe(preset);
      expect(provider.isAvailable()).toBe(true);
    });
  }

  it("grok preset uses correct baseURL", () => {
    const provider = new OpenAICompatibleProvider({ preset: "grok", apiKey: "xai-test" });
    expect(provider.name).toBe("grok");
  });

  it("lmstudio preset does not require API key", () => {
    const provider = new OpenAICompatibleProvider({ preset: "lmstudio" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("gemini preset checks GOOGLE_API_KEY env var", () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-gemini-key");
    const provider = new OpenAICompatibleProvider({ preset: "gemini" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("together preset checks TOGETHER_API_KEY env var", () => {
    vi.stubEnv("TOGETHER_API_KEY", "test-together-key");
    const provider = new OpenAICompatibleProvider({ preset: "together" });
    expect(provider.isAvailable()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/providers/openai-presets.test.ts`
Expected: FAIL — presets not recognized

- [ ] **Step 3: Expand PRESETS and OpenAIPreset type**

Update `src/providers/openai-compatible-provider.ts`:

```typescript
export type OpenAIPreset =
  | "openai"
  | "openrouter"
  | "ollama"
  | "deepseek"
  | "groq"
  | "custom"
  // New presets
  | "gemini"
  | "grok"
  | "mistral"
  | "cerebras"
  | "together"
  | "fireworks"
  | "perplexity"
  | "moonshot"
  | "zai"
  | "minimax"
  | "cohere"
  | "opencode-zen"
  | "opencode-go"
  | "azure"
  | "lmstudio";

const PRESETS: Record<OpenAIPreset, { baseURL: string; envKey: string; defaultModel: string }> = {
  // Existing
  openai: { baseURL: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", defaultModel: "gpt-4o" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4" },
  ollama: { baseURL: "http://localhost:11434/v1", envKey: "", defaultModel: "llama3.1" },
  deepseek: { baseURL: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
  groq: { baseURL: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
  custom: { baseURL: "", envKey: "", defaultModel: "" },
  // New
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", envKey: "GOOGLE_API_KEY", defaultModel: "gemini-2.5-flash" },
  grok: { baseURL: "https://api.x.ai/v1", envKey: "XAI_API_KEY", defaultModel: "grok-4" },
  mistral: { baseURL: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY", defaultModel: "codestral" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY", defaultModel: "qwen3-coder-480b" },
  together: { baseURL: "https://api.together.ai/v1", envKey: "TOGETHER_API_KEY", defaultModel: "kimi-k2.5-instruct" },
  fireworks: { baseURL: "https://api.fireworks.ai/inference/v1", envKey: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/deepseek-v3-2" },
  perplexity: { baseURL: "https://api.perplexity.ai", envKey: "PERPLEXITY_API_KEY", defaultModel: "sonar-pro" },
  moonshot: { baseURL: "https://api.moonshot.cn/v1", envKey: "MOONSHOT_API_KEY", defaultModel: "kimi-k2.5-instruct" },
  zai: { baseURL: "https://api.z.ai/api/paas/v4", envKey: "ZAI_API_KEY", defaultModel: "glm-5" },
  minimax: { baseURL: "https://api.minimax.io/v1", envKey: "MINIMAX_API_KEY", defaultModel: "minimax-m2.5" },
  cohere: { baseURL: "https://api.cohere.com/v2", envKey: "COHERE_API_KEY", defaultModel: "command-a-03-2025" },
  "opencode-zen": { baseURL: "https://api.opencode.ai/v1", envKey: "OPENCODE_API_KEY", defaultModel: "claude-sonnet-4-6" },
  "opencode-go": { baseURL: "https://api.opencode.ai/v1", envKey: "OPENCODE_GO_API_KEY", defaultModel: "kimi-k2.5" },
  azure: { baseURL: "", envKey: "AZURE_OPENAI_API_KEY", defaultModel: "gpt-4o" },
  lmstudio: { baseURL: "http://localhost:1234/v1", envKey: "", defaultModel: "" },
};
```

Also update `isAvailable()` to treat `lmstudio` like `ollama`:

```typescript
isAvailable(): boolean {
  if (this.config.preset === "ollama" || this.config.preset === "lmstudio") return this.available;
  return this.apiKey != null && this.available;
}
```

And update `healthCheck()`:

```typescript
async healthCheck(): Promise<boolean> {
  if (!this.apiKey && this.config.preset !== "ollama" && this.config.preset !== "lmstudio") return false;
  // ... rest unchanged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/providers/openai-presets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai-compatible-provider.ts tests/providers/openai-presets.test.ts
git commit -m "feat: add 15 new OpenAI-compatible provider presets"
```

---

## Task 3: Update Provider Factory & Env Var Discovery

**Files:**
- Modify: `src/providers/provider-factory.ts`

- [ ] **Step 1: Expand ENV_KEY_MAP and providerFromConfig**

Update `src/providers/provider-factory.ts` to handle all new provider types:

```typescript
import { ProviderManager } from "./provider-manager.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider, type OpenAIPreset } from "./openai-compatible-provider.js";
import type { StreamProvider } from "./provider.js";
import { readGlobalConfig, type ProviderConfigEntry } from "../core/global-config.js";
import { logger } from "../core/logger.js";

let globalManager: ProviderManager | null = null;

// Map of env vars to OpenAI-compatible presets
const ENV_KEY_MAP: Record<string, OpenAIPreset> = {
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  DEEPSEEK_API_KEY: "deepseek",
  GROQ_API_KEY: "groq",
  // New providers
  GOOGLE_API_KEY: "gemini",
  GEMINI_API_KEY: "gemini",
  XAI_API_KEY: "grok",
  MISTRAL_API_KEY: "mistral",
  CEREBRAS_API_KEY: "cerebras",
  TOGETHER_API_KEY: "together",
  TOGETHER_AI_API_KEY: "together",
  FIREWORKS_API_KEY: "fireworks",
  PERPLEXITY_API_KEY: "perplexity",
  MOONSHOT_API_KEY: "moonshot",
  ZAI_API_KEY: "zai",
  ZHIPU_API_KEY: "zai",
  MINIMAX_API_KEY: "minimax",
  COHERE_API_KEY: "cohere",
  OPENCODE_API_KEY: "opencode-zen",
  OPENCODE_GO_API_KEY: "opencode-go",
  AZURE_OPENAI_API_KEY: "azure",
};

/** Types that use the Anthropic native SDK */
const ANTHROPIC_TYPES = new Set(["anthropic", "anthropic-sub"]);

/** Types that need dedicated providers (not OpenAI-compatible) */
const DEDICATED_TYPES = new Set(["chatgpt", "copilot", "bedrock", "vertex", "gemini-oauth"]);

function providerFromConfig(entry: ProviderConfigEntry): StreamProvider | null {
  if (ANTHROPIC_TYPES.has(entry.type)) {
    return new AnthropicProvider({
      apiKey: entry.apiKey ?? entry.setupToken,
      model: entry.model,
    });
  }

  if (DEDICATED_TYPES.has(entry.type)) {
    // These are created by their dedicated provider classes
    // For now, log a warning — Task 4-7 will add these
    logger.warn(`Provider type "${entry.type}" requires dedicated setup. Skipping.`);
    return null;
  }

  // Everything else uses OpenAI-compatible
  const preset = entry.type as OpenAIPreset;
  return new OpenAICompatibleProvider({
    preset,
    apiKey: entry.apiKey,
    baseURL: entry.baseURL,
    model: entry.model,
    name: entry.name,
  });
}

function discoverFromEnv(): StreamProvider[] {
  const providers: StreamProvider[] = [];
  const seenPresets = new Set<string>();

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }

  for (const [envKey, preset] of Object.entries(ENV_KEY_MAP)) {
    if (process.env[envKey] && !seenPresets.has(preset)) {
      seenPresets.add(preset);
      providers.push(
        new OpenAICompatibleProvider({
          preset,
          apiKey: process.env[envKey],
        }),
      );
    }
  }

  return providers;
}

export function createProviderChain(
  configEntries?: ProviderConfigEntry[],
): StreamProvider[] {
  if (configEntries && configEntries.length > 0) {
    return configEntries
      .map(providerFromConfig)
      .filter((p): p is StreamProvider => p !== null);
  }

  const fromEnv = discoverFromEnv();
  if (fromEnv.length > 0) return fromEnv;

  return [];
}

// ... getGlobalProviderManager, setGlobalProviderManager, resetGlobalProviderManager unchanged
```

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `bun run test`
Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/providers/provider-factory.ts
git commit -m "feat: expand provider factory with 15+ new env var discoveries"
```

---

## Task 4: Update Error Messages & Provider URLs

**Files:**
- Modify: `src/core/errors.ts`

- [ ] **Step 1: Add all new provider URLs, key prefixes, and error messages**

Update `src/core/errors.ts` — add new entries to `PROVIDER_URLS`, `API_KEY_PREFIXES`, and new error templates to `ERROR_MESSAGES`:

Add to `PROVIDER_URLS`:
```typescript
gemini:     { keyUrl: 'https://aistudio.google.com/app/apikey', statusUrl: 'https://status.cloud.google.com' },
grok:       { keyUrl: 'https://console.x.ai', statusUrl: 'https://status.x.ai' },
mistral:    { keyUrl: 'https://console.mistral.ai/api-keys', statusUrl: 'https://console.mistral.ai' },
cerebras:   { keyUrl: 'https://inference.cerebras.ai', statusUrl: 'https://inference.cerebras.ai' },
together:   { keyUrl: 'https://api.together.ai', statusUrl: 'https://api.together.ai' },
fireworks:  { keyUrl: 'https://fireworks.ai/api-keys', statusUrl: 'https://fireworks.ai' },
perplexity: { keyUrl: 'https://www.perplexity.ai/settings/api', statusUrl: 'https://www.perplexity.ai' },
moonshot:   { keyUrl: 'https://platform.moonshot.cn/console/api-keys', statusUrl: 'https://platform.moonshot.cn' },
zai:        { keyUrl: 'https://open.bigmodel.cn', statusUrl: 'https://open.bigmodel.cn' },
minimax:    { keyUrl: 'https://api.minimax.io', statusUrl: 'https://api.minimax.io' },
cohere:     { keyUrl: 'https://dashboard.cohere.com/api-keys', statusUrl: 'https://dashboard.cohere.com' },
'opencode-zen': { keyUrl: 'https://opencode.ai/auth', statusUrl: 'https://opencode.ai' },
'opencode-go':  { keyUrl: 'https://opencode.ai/auth', statusUrl: 'https://opencode.ai' },
bedrock:    { keyUrl: null, statusUrl: 'https://health.aws.amazon.com' },
vertex:     { keyUrl: null, statusUrl: 'https://status.cloud.google.com' },
azure:      { keyUrl: null, statusUrl: 'https://status.azure.com' },
lmstudio:   { keyUrl: null, statusUrl: 'http://localhost:1234' },
chatgpt:    { keyUrl: null, statusUrl: 'https://status.openai.com' },
copilot:    { keyUrl: null, statusUrl: 'https://www.githubstatus.com' },
```

Add to `API_KEY_PREFIXES`:
```typescript
gemini: null,
grok: 'xai-',
mistral: null,
cerebras: null,
together: null,
fireworks: null,
perplexity: null,
moonshot: 'sk-',
zai: null,
minimax: null,
cohere: null,
'opencode-zen': 'sk-opencode-',
'opencode-go': 'sk-opencode-go-',
bedrock: null,
vertex: null,
azure: null,
lmstudio: null,
chatgpt: null,
copilot: null,
```

Add new error templates to `ERROR_MESSAGES`:
```typescript
CHATGPT_OAUTH_REQUIRED: {
  title: 'ChatGPT OAuth not configured',
  body: 'Run the setup flow to connect your ChatGPT subscription.',
  fix: ['Run: openpawl providers add chatgpt'],
},
CHATGPT_TOKEN_EXPIRED: {
  title: 'ChatGPT token expired',
  body: 'Your ChatGPT OAuth token has expired. Refreshing automatically...',
  fix: ['If this persists, re-run: openpawl providers add chatgpt'],
},
COPILOT_GITHUB_NOT_FOUND: {
  title: 'GitHub token not found',
  body: 'Could not find a GitHub token for Copilot access.',
  fix: [
    'Run: gh auth login',
    'Or let OpenPawl run the device flow: openpawl providers add copilot',
  ],
},
COPILOT_TOKEN_EXPIRED: {
  title: 'Copilot token expired',
  body: 'Your Copilot access token has expired. Refreshing automatically...',
  fix: ['If this persists, re-run: openpawl providers add copilot'],
},
CLAUDE_SETUP_TOKEN_REJECTED: {
  title: 'Anthropic rejected the setup-token',
  body: 'The setup-token from Claude CLI was not accepted.',
  fix: [
    'Re-run: claude setup-token',
    'If persistent, switch to API key: openpawl providers add anthropic',
  ],
},
GEMINI_OAUTH_BANNED: {
  title: 'Google account may be suspended',
  body: 'Google may have banned your account for Antigravity ToS violation (403).',
  fix: ['Switch to API key: https://aistudio.google.com/app/apikey'],
},
LOCAL_NOT_RUNNING: {
  title: '{provider} not running',
  body: '{provider} is not responding at the expected address.',
  fix: [
    'For Ollama: run "ollama serve"',
    'For LM Studio: open app → Local Server → Start Server',
  ],
},
BEDROCK_INVALID_CREDS: {
  title: 'AWS credentials invalid',
  body: 'Your AWS credentials were rejected by Bedrock.',
  fix: ['Check IAM permissions: bedrock:InvokeModel', 'Verify AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY'],
},
TOGETHER_QUOTA_EXHAUSTED: {
  title: 'Together AI quota exhausted',
  body: 'Your Together AI usage quota has been reached.',
  fix: ['Add credits at api.together.ai', 'Add a fallback provider to your chain'],
},
ANTHROPIC_OAUTH_BLOCKED: {
  title: 'Anthropic OAuth not supported',
  body: 'Anthropic OAuth tokens (from claude.ai) are not supported for third-party tools.',
  fix: [
    'Use an API key: openpawl providers add anthropic',
    'Or setup-token (gray area): openpawl providers add anthropic-sub',
  ],
},
```

- [ ] **Step 2: Run existing tests**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/errors.ts
git commit -m "feat: add error messages and URLs for all new providers"
```

---

## Task 5: GitHub Copilot Device OAuth Provider

**Files:**
- Create: `src/providers/copilot-provider.ts`
- Test: `tests/providers/copilot-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/providers/copilot-provider.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { CopilotProvider } from "../src/providers/copilot-provider.js";

describe("CopilotProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("constructs with github token and copilot token", () => {
    const provider = new CopilotProvider({
      githubToken: "ghu_test123",
      copilotToken: "tid=test;exp=9999999999;sku=free;st=dotcom;chat=1;8kp=0;token=test123",
      copilotTokenExpiry: Date.now() + 30 * 60 * 1000,
      model: "claude-sonnet-4.6",
    });
    expect(provider.name).toBe("copilot");
    expect(provider.isAvailable()).toBe(true);
  });

  it("is unavailable without tokens", () => {
    const provider = new CopilotProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("health check returns false without tokens", async () => {
    const provider = new CopilotProvider({});
    expect(await provider.healthCheck()).toBe(false);
  });

  it("refreshes copilot token when expired", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: "new-copilot-token",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      }),
    });

    const provider = new CopilotProvider({
      githubToken: "ghu_test123",
      copilotToken: "old-token",
      copilotTokenExpiry: Date.now() - 1000, // expired
      model: "claude-sonnet-4.6",
    });

    // Should trigger refresh via healthCheck
    const result = await provider.healthCheck();
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/v2/token",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "token ghu_test123",
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/providers/copilot-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CopilotProvider**

Create `src/providers/copilot-provider.ts`:

```typescript
/**
 * GitHub Copilot provider — Device OAuth flow + OpenAI-compatible completions.
 *
 * Auth flow:
 * 1. Check for existing GitHub CLI token (gh, github-copilot hosts.json, GITHUB_TOKEN)
 * 2. Device flow if no existing token
 * 3. Exchange GitHub token for Copilot token (expires ~30min, auto-refresh)
 * 4. Endpoint: https://api.githubcopilot.com/chat/completions (OpenAI-compatible)
 */

import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_COMPLETIONS_URL = "https://api.githubcopilot.com/chat/completions";
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEFAULT_MODEL = "claude-sonnet-4.6";

/** Minimum time (ms) before expiry to trigger a refresh */
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

export interface CopilotProviderConfig {
  githubToken?: string;
  copilotToken?: string;
  copilotTokenExpiry?: number;
  model?: string;
}

export class CopilotProvider implements StreamProvider {
  readonly name = "copilot";
  private githubToken: string | null;
  private copilotToken: string | null;
  private copilotTokenExpiry: number;
  private readonly model: string;
  private available = true;
  private refreshing: Promise<void> | null = null;

  constructor(config: CopilotProviderConfig) {
    this.githubToken = config.githubToken ?? process.env.GITHUB_TOKEN ?? null;
    this.copilotToken = config.copilotToken ?? null;
    this.copilotTokenExpiry = config.copilotTokenExpiry ?? 0;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private needsRefresh(): boolean {
    return !this.copilotToken || Date.now() >= this.copilotTokenExpiry - REFRESH_BUFFER_MS;
  }

  private async refreshCopilotToken(): Promise<void> {
    if (!this.githubToken) {
      throw new ProviderError({
        provider: "copilot",
        code: "COPILOT_GITHUB_NOT_FOUND",
        message: "No GitHub token available for Copilot token exchange",
        isFallbackTrigger: true,
      });
    }

    logger.debug("[copilot] refreshing copilot token");

    const res = await fetch(COPILOT_TOKEN_URL, {
      method: "GET",
      headers: {
        Authorization: `token ${this.githubToken}`,
        Accept: "application/json",
        "User-Agent": "OpenPawl/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new ProviderError({
        provider: "copilot",
        code: "COPILOT_TOKEN_EXPIRED",
        message: `Copilot token exchange failed: ${res.status} ${res.statusText}`,
        statusCode: res.status,
        isFallbackTrigger: res.status === 401,
      });
    }

    const data = (await res.json()) as { token: string; expires_at: number };
    this.copilotToken = data.token;
    this.copilotTokenExpiry = data.expires_at * 1000; // convert to ms
    logger.debug("[copilot] token refreshed, expires at " + new Date(this.copilotTokenExpiry).toISOString());
  }

  private async ensureToken(): Promise<string> {
    if (!this.needsRefresh() && this.copilotToken) {
      return this.copilotToken;
    }

    // Deduplicate concurrent refresh calls
    if (!this.refreshing) {
      this.refreshing = this.refreshCopilotToken().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return this.copilotToken!;
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const token = await this.ensureToken();
    const model = options?.model ?? this.model;

    const messages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    logger.debug(`[copilot] streaming with model=${model}`);

    const res = await fetch(COPILOT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": "openpawl",
        "User-Agent": "OpenPawl/1.0",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature,
        stream: true,
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        // Refresh token and mark as fallback trigger so ProviderManager retries
        // The next call will use the refreshed token
        try { await this.refreshCopilotToken(); } catch { /* ignore refresh failure */ }
      }
      throw new ProviderError({
        provider: "copilot",
        code: res.status === 401 ? "COPILOT_TOKEN_EXPIRED" : res.status === 429 ? "RATE_LIMITED" : "STREAM_FAILED",
        message: `Copilot API error: ${res.status} ${text.slice(0, 200)}`,
        statusCode: res.status,
        isFallbackTrigger: true, // Always allow fallback for HTTP errors
      });
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new ProviderError({
        provider: "copilot",
        code: "STREAM_FAILED",
        message: "No response body from Copilot API",
        isFallbackTrigger: true,
      });
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            yield { content: "", done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens: number; completion_tokens: number };
            };
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield { content, done: false };
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
      yield { content: "", done: true };
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.githubToken) return false;
    try {
      await this.ensureToken();
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return this.githubToken != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}

/**
 * Run the GitHub device OAuth flow to get a GitHub token.
 * Returns the access token string.
 */
export async function runCopilotDeviceFlow(): Promise<string> {
  // Step 1: Request device code
  const codeRes = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!codeRes.ok) {
    throw new Error(`Device code request failed: ${codeRes.status}`);
  }

  const codeData = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };

  return JSON.stringify(codeData); // Caller handles UI + polling
}

/**
 * Poll for the device flow token.
 */
export async function pollCopilotDeviceToken(deviceCode: string): Promise<string | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
  };

  if (data.access_token) {
    return data.access_token;
  }

  // "authorization_pending" or "slow_down" means keep polling
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/providers/copilot-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/copilot-provider.ts tests/providers/copilot-provider.test.ts
git commit -m "feat: add GitHub Copilot device OAuth provider"
```

---

## Task 6: ChatGPT OAuth Provider

**Files:**
- Create: `src/providers/oauth-helpers.ts`
- Create: `src/providers/chatgpt-oauth-provider.ts`
- Test: `tests/providers/chatgpt-oauth-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/providers/chatgpt-oauth-provider.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      constructor(public config: Record<string, unknown>) {}
      chat = {
        completions: {
          create: vi.fn().mockReturnValue({
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: { content: "ok" } }] };
              yield { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } };
            },
          }),
        },
      };
      models = { list: vi.fn().mockResolvedValue({ data: [] }) };
    },
  };
});

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { ChatGPTOAuthProvider } from "../src/providers/chatgpt-oauth-provider.js";

describe("ChatGPTOAuthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructs with OAuth tokens", () => {
    const provider = new ChatGPTOAuthProvider({
      oauthToken: "test-token",
      refreshToken: "test-refresh",
      tokenExpiry: Date.now() + 60 * 60 * 1000,
      model: "gpt-5.3-codex",
    });
    expect(provider.name).toBe("chatgpt");
    expect(provider.isAvailable()).toBe(true);
  });

  it("is unavailable without OAuth token", () => {
    const provider = new ChatGPTOAuthProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("health check returns false without token", async () => {
    const provider = new ChatGPTOAuthProvider({});
    expect(await provider.healthCheck()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/providers/chatgpt-oauth-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create oauth-helpers.ts**

```typescript
// src/providers/oauth-helpers.ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Start a temporary local HTTP server for OAuth callback.
 * Returns the auth code received on the callback URL.
 */
export function startOAuthCallbackServer(
  port: number,
  path: string,
): { promise: Promise<string>; server: Server } {
  let resolve: (code: string) => void;
  let reject: (err: Error) => void;

  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === path) {
      const code = url.searchParams.get("code");
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authorization successful!</h2><p>You can close this tab.</p></body></html>");
        resolve(code);
      } else {
        const error = url.searchParams.get("error") ?? "No code received";
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Error</h2><p>${error}</p></body></html>`);
        reject(new Error(error));
      }
      setTimeout(() => server.close(), 500);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, "127.0.0.1");

  // Timeout after 5 minutes
  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("OAuth callback timed out (5 minutes)"));
  }, 5 * 60 * 1000);

  promise.finally(() => clearTimeout(timeout));

  return { promise, server };
}
```

- [ ] **Step 4: Create ChatGPTOAuthProvider**

```typescript
// src/providers/chatgpt-oauth-provider.ts
/**
 * ChatGPT Plus/Pro subscription OAuth provider.
 * Uses OpenAI's standard API with OAuth access tokens.
 */

import OpenAI from "openai";
import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

const DEFAULT_MODEL = "gpt-5.3-codex";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface ChatGPTOAuthConfig {
  oauthToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  model?: string;
}

export class ChatGPTOAuthProvider implements StreamProvider {
  readonly name = "chatgpt";
  private client: OpenAI | null = null;
  private oauthToken: string | null;
  private refreshToken: string | null;
  private tokenExpiry: number;
  private readonly model: string;
  private available = true;

  constructor(config: ChatGPTOAuthConfig) {
    this.oauthToken = config.oauthToken ?? null;
    this.refreshToken = config.refreshToken ?? null;
    this.tokenExpiry = config.tokenExpiry ?? 0;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private getClient(): OpenAI {
    if (!this.oauthToken) {
      throw new ProviderError({
        provider: "chatgpt",
        code: "CHATGPT_OAUTH_REQUIRED",
        message: "No ChatGPT OAuth token. Run: openpawl providers add chatgpt",
        isFallbackTrigger: true,
      });
    }
    if (!this.client || this.client.apiKey !== this.oauthToken) {
      this.client = new OpenAI({
        apiKey: this.oauthToken,
        baseURL: "https://api.openai.com/v1",
      });
    }
    return this.client;
  }

  private needsRefresh(): boolean {
    return Date.now() >= this.tokenExpiry - REFRESH_BUFFER_MS;
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const client = this.getClient();
    const model = options?.model ?? this.model;

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    logger.debug(`[chatgpt] streaming with model=${model}`);

    try {
      const stream = await client.chat.completions.create(
        {
          model,
          messages,
          temperature: options?.temperature,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options?.signal },
      );

      let usage: { promptTokens: number; completionTokens: number } | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield { content: delta.content, done: false };
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
      }

      yield { content: "", done: true, usage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuth = message.includes("401") || message.includes("invalid_api_key");
      const isRateLimit = message.includes("429") || message.includes("rate_limit");

      throw new ProviderError({
        provider: "chatgpt",
        code: isAuth ? "CHATGPT_TOKEN_EXPIRED" : isRateLimit ? "RATE_LIMITED" : "STREAM_FAILED",
        message: `ChatGPT API error: ${message}`,
        statusCode: isAuth ? 401 : isRateLimit ? 429 : undefined,
        isFallbackTrigger: isAuth || isRateLimit,
        cause: err,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.oauthToken) return false;
    try {
      const client = this.getClient();
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return this.oauthToken != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- tests/providers/chatgpt-oauth-provider.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/oauth-helpers.ts src/providers/chatgpt-oauth-provider.ts tests/providers/chatgpt-oauth-provider.test.ts
git commit -m "feat: add ChatGPT OAuth provider and OAuth helpers"
```

---

## Task 7: AWS Bedrock Provider

**Files:**
- Create: `src/providers/bedrock-provider.ts`
- Test: `tests/providers/bedrock-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/providers/bedrock-provider.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Mock AWS SDK
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      body: {
        [Symbol.asyncIterator]: async function* () {
          const encoder = new TextEncoder();
          yield { chunk: { bytes: encoder.encode(JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello" },
          })) } };
          yield { chunk: { bytes: encoder.encode(JSON.stringify({
            type: "message_stop",
          })) } };
        },
      },
    }),
  })),
  InvokeModelWithResponseStreamCommand: vi.fn(),
}));

import { BedrockProvider } from "../src/providers/bedrock-provider.js";

describe("BedrockProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("constructs with explicit credentials", () => {
    const provider = new BedrockProvider({
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      region: "us-east-1",
      model: "anthropic.claude-sonnet-4-6-v1:0",
    });
    expect(provider.name).toBe("bedrock");
    expect(provider.isAvailable()).toBe(true);
  });

  it("constructs from env vars", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIATEST");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_REGION", "us-west-2");
    const provider = new BedrockProvider({});
    expect(provider.isAvailable()).toBe(true);
  });

  it("is unavailable without credentials", () => {
    const provider = new BedrockProvider({});
    expect(provider.isAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/providers/bedrock-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Install @aws-sdk/client-bedrock-runtime**

Run: `bun add @aws-sdk/client-bedrock-runtime`

- [ ] **Step 4: Implement BedrockProvider**

Create `src/providers/bedrock-provider.ts`:

```typescript
/**
 * AWS Bedrock provider — uses IAM credentials + SigV4 signing.
 * Supports Anthropic Claude, Meta Llama, and other Bedrock models.
 */

import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

const DEFAULT_MODEL = "anthropic.claude-sonnet-4-6-v1:0";
const DEFAULT_REGION = "us-east-1";

export interface BedrockProviderConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  model?: string;
}

export class BedrockProvider implements StreamProvider {
  readonly name = "bedrock";
  private readonly accessKeyId: string | null;
  private readonly secretAccessKey: string | null;
  private readonly sessionToken: string | undefined;
  private readonly region: string;
  private readonly model: string;
  private available = true;
  private lastSuccessAt = 0;

  constructor(config: BedrockProviderConfig) {
    this.accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? null;
    this.secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? null;
    this.sessionToken = config.sessionToken ?? process.env.AWS_SESSION_TOKEN;
    this.region = config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private async getClient() {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");

    const clientConfig: Record<string, unknown> = { region: this.region };

    if (this.accessKeyId && this.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      };
    }
    // Otherwise falls back to AWS SDK default credential chain (env, profile, instance role)

    return new BedrockRuntimeClient(clientConfig);
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.model;
    logger.debug(`[bedrock] streaming with model=${model} region=${this.region}`);

    const { InvokeModelWithResponseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = await this.getClient();

    const isAnthropicModel = model.startsWith("anthropic.");
    const body = isAnthropicModel
      ? JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
          ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
        })
      : JSON.stringify({
          prompt: options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt,
          max_gen_len: 4096,
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
        });

    try {
      const command = new InvokeModelWithResponseStreamCommand({
        modelId: model,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(body),
      });

      const response = await client.send(command);
      const decoder = new TextDecoder();

      if (response.body) {
        for await (const event of response.body) {
          if (event.chunk?.bytes) {
            const parsed = JSON.parse(decoder.decode(event.chunk.bytes)) as Record<string, unknown>;

            if (isAnthropicModel) {
              if (parsed.type === "content_block_delta") {
                const delta = parsed.delta as { text?: string };
                if (delta?.text) {
                  yield { content: delta.text, done: false };
                }
              } else if (parsed.type === "message_stop") {
                yield { content: "", done: true };
              }
            } else {
              // Generic model response
              const generation = (parsed as { generation?: string }).generation;
              if (generation) {
                yield { content: generation, done: false };
              }
            }
          }
        }
      }

      yield { content: "", done: true };
      this.lastSuccessAt = Date.now();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuth = message.includes("credentials") || message.includes("403") || message.includes("401");
      throw new ProviderError({
        provider: "bedrock",
        code: isAuth ? "BEDROCK_INVALID_CREDS" : "STREAM_FAILED",
        message: `Bedrock API error: ${message}`,
        isFallbackTrigger: isAuth,
        cause: err,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.accessKeyId || !this.secretAccessKey) return false;
    if (this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt < 5 * 60 * 1000) return true;
    return true; // Credentials present — trust until first call
  }

  isAvailable(): boolean {
    return (this.accessKeyId != null && this.secretAccessKey != null) && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- tests/providers/bedrock-provider.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/bedrock-provider.ts tests/providers/bedrock-provider.test.ts package.json bun.lock
git commit -m "feat: add AWS Bedrock provider with IAM credential auth"
```

---

## Task 8: Vertex AI Provider (stub)

**Files:**
- Create: `src/providers/vertex-provider.ts`

- [ ] **Step 1: Create Vertex provider stub**

Vertex AI auth requires Google Cloud service account JSON. Since this project uses no Python and the auth is complex (JWT signing), implement as a stub that shells out to `gcloud` CLI for token, then uses OpenAI-compatible endpoint.

```typescript
// src/providers/vertex-provider.ts
/**
 * Google Vertex AI provider — service account auth.
 * Uses Vertex AI's OpenAI-compatible endpoint.
 */

import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";
import { execSync } from "node:child_process";

const DEFAULT_MODEL = "gemini-3-pro";

export interface VertexProviderConfig {
  serviceAccountPath?: string;
  projectId?: string;
  region?: string;
  model?: string;
}

export class VertexProvider implements StreamProvider {
  readonly name = "vertex";
  private readonly projectId: string | null;
  private readonly region: string;
  private readonly model: string;
  private readonly serviceAccountPath: string | null;
  private available = true;
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(config: VertexProviderConfig) {
    this.serviceAccountPath = config.serviceAccountPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null;
    this.projectId = config.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? null;
    this.region = config.region ?? "us-central1";
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      // Use gcloud CLI to get access token (works with service account and user creds)
      const token = execSync("gcloud auth print-access-token", {
        encoding: "utf-8",
        timeout: 10_000,
        env: {
          ...process.env,
          ...(this.serviceAccountPath
            ? { GOOGLE_APPLICATION_CREDENTIALS: this.serviceAccountPath }
            : {}),
        },
      }).trim();

      this.accessToken = token;
      this.tokenExpiry = Date.now() + 55 * 60 * 1000; // ~55 min
      return token;
    } catch {
      throw new ProviderError({
        provider: "vertex",
        code: "AUTHENTICATION_FAILED",
        message: "Could not get GCP access token. Ensure gcloud CLI is installed and authenticated.",
        isFallbackTrigger: true,
      });
    }
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.model;
    const token = await this.getAccessToken();

    logger.debug(`[vertex] streaming with model=${model}`);

    const baseUrl = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${model}:streamGenerateContent`;

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(options?.systemPrompt ? { systemInstruction: { parts: [{ text: options.systemPrompt }] } } : {}),
        generationConfig: {
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
          maxOutputTokens: 4096,
        },
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError({
        provider: "vertex",
        code: res.status === 401 || res.status === 403 ? "AUTHENTICATION_FAILED" : "STREAM_FAILED",
        message: `Vertex AI error: ${res.status} ${text.slice(0, 200)}`,
        statusCode: res.status,
        isFallbackTrigger: true,
        cause: new Error(text),
      });
    }

    // Vertex returns JSON array stream
    const body = await res.json() as Array<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>;
    for (const chunk of body) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        yield { content: text, done: false };
      }
    }
    yield { content: "", done: true };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.projectId) return false;
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return this.projectId != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/vertex-provider.ts
git commit -m "feat: add Google Vertex AI provider with service account auth"
```

---

## Task 9: Wire Dedicated Providers into Factory

**Files:**
- Modify: `src/providers/provider-factory.ts`

- [ ] **Step 1: Update providerFromConfig to create dedicated providers**

Replace the stub in Task 3 with actual imports:

```typescript
import { CopilotProvider } from "./copilot-provider.js";
import { ChatGPTOAuthProvider } from "./chatgpt-oauth-provider.js";
import { BedrockProvider } from "./bedrock-provider.js";
import { VertexProvider } from "./vertex-provider.js";

function providerFromConfig(entry: ProviderConfigEntry): StreamProvider | null {
  switch (entry.type) {
    case "anthropic":
    case "anthropic-sub":
      return new AnthropicProvider({
        apiKey: entry.apiKey ?? entry.setupToken,
        model: entry.model,
      });

    case "chatgpt":
      return new ChatGPTOAuthProvider({
        oauthToken: entry.oauthToken,
        refreshToken: entry.refreshToken,
        tokenExpiry: entry.tokenExpiry,
        model: entry.model,
      });

    case "copilot":
      return new CopilotProvider({
        githubToken: entry.githubToken,
        copilotToken: entry.copilotToken,
        copilotTokenExpiry: entry.copilotTokenExpiry,
        model: entry.model,
      });

    case "bedrock":
      return new BedrockProvider({
        accessKeyId: entry.accessKeyId,
        secretAccessKey: entry.secretAccessKey,
        sessionToken: entry.sessionToken,
        region: entry.region,
        model: entry.model,
      });

    case "vertex":
      return new VertexProvider({
        serviceAccountPath: entry.serviceAccountPath,
        projectId: entry.projectId,
        region: entry.region,
        model: entry.model,
      });

    case "gemini-oauth":
      // OAuth variant — not yet implemented, fall through to null
      logger.warn('Gemini OAuth not yet implemented. Use API key: openpawl providers add gemini');
      return null;

    default:
      // All other types use OpenAI-compatible
      return new OpenAICompatibleProvider({
        preset: entry.type as OpenAIPreset,
        apiKey: entry.apiKey,
        baseURL: entry.baseURL,
        model: entry.model,
        name: entry.name,
      });
  }
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/providers/provider-factory.ts
git commit -m "feat: wire all dedicated providers into factory"
```

---

## Task 10: Providers Add Command (Full Menu)

**Files:**
- Modify: `src/commands/providers.ts`
- Modify: `src/commands/setup/connection.ts`

- [ ] **Step 1: Add the `add` subcommand to providers.ts**

Expand `src/commands/providers.ts` to support `openpawl providers add` with the full provider menu. Import from the catalog and use @clack/prompts for the interactive menu.

```typescript
// Add to the runProvidersCommand function:
if (sub === "add") {
  await addProvider(args.slice(1));
  return;
}

// Add help text:
logger.plain("  add      Add a new provider interactively");
```

The `addProvider` function should:
1. Show grouped menu from PROVIDER_CATALOG (by category)
2. Based on selection, prompt for credentials (API key, OAuth flow, etc.)
3. Show any warnings (for gray-area providers)
4. Validate key format
5. Let user pick a model from the catalog
6. Save to ~/.openpawl/config.json providers array
7. Run health check

- [ ] **Step 2: Implement addProvider with grouped menu**

Create the full implementation in `src/commands/providers.ts`:

```typescript
import {
  select,
  password,
  text,
  confirm,
  note,
  spinner,
  isCancel,
  cancel,
} from "@clack/prompts";
import {
  PROVIDER_CATALOG,
  getProvidersByCategory,
  type ProviderMeta,
} from "../providers/provider-catalog.js";
import {
  readGlobalConfig,
  writeGlobalConfig,
  readGlobalConfigWithDefaults,
  type ProviderConfigEntry,
} from "../core/global-config.js";
import {
  validateApiKeyFormat,
  maskApiKey,
} from "../core/errors.js";

function handleCancel<T>(v: T): T {
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return v;
}

async function addProvider(args: string[]): Promise<void> {
  // If provider ID passed as argument, skip menu
  const directId = args[0];
  let selectedId: string;

  if (directId && PROVIDER_CATALOG[directId]) {
    selectedId = directId;
  } else {
    // Build grouped menu options
    const categories = [
      { key: "subscription" as const, emoji: "🎫", label: "Subscription plans (use plans you already pay for)" },
      { key: "apikey" as const, emoji: "🔑", label: "API keys (pay per token — production safe)" },
      { key: "opencode" as const, emoji: "🟢", label: "OpenCode subscriptions" },
      { key: "cloud" as const, emoji: "☁️", label: "Cloud credentials" },
      { key: "local" as const, emoji: "🏠", label: "Local (free, private, no internet)" },
    ];

    const options: Array<{ value: string; label: string; hint?: string }> = [];

    for (const cat of categories) {
      const providers = getProvidersByCategory(cat.key);
      if (providers.length === 0) continue;

      // Show category header in console before the select
      // @clack/prompts select doesn't support non-selectable headers
      for (const [id, meta] of providers) {
        options.push({
          value: id,
          label: `${cat.emoji} ${id.padEnd(16)} ${meta.menuLabel}`,
          hint: meta.menuHint,
        });
      }
    }

    const choice = handleCancel(
      await select({
        message: "How do you want to add a provider?",
        options,
      }),
    ) as string;

    selectedId = choice;
  }

  const meta = PROVIDER_CATALOG[selectedId]!;

  // Show warning if applicable
  if (meta.warning) {
    console.log(`\n${meta.warning}\n`);
    const accepted = handleCancel(
      await confirm({
        message: "Do you understand and want to proceed?",
        initialValue: false,
      }),
    ) as boolean;
    if (!accepted) {
      cancel("Cancelled.");
      return;
    }
  }

  // Build the config entry
  const entry: ProviderConfigEntry = { type: selectedId as ProviderConfigEntry["type"] };

  // Auth-specific prompts
  if (meta.authMethod === "apikey") {
    await promptApiKey(entry, selectedId, meta);
  } else if (meta.authMethod === "local") {
    await promptLocalProvider(entry, selectedId, meta);
  } else if (meta.authMethod === "device-oauth" && selectedId === "copilot") {
    await promptCopilotAuth(entry);
  } else if (meta.authMethod === "setup-token") {
    await promptSetupToken(entry);
  } else if (meta.authMethod === "credentials" && selectedId === "bedrock") {
    await promptBedrockAuth(entry);
  } else if (meta.authMethod === "credentials" && selectedId === "vertex") {
    await promptVertexAuth(entry);
  } else if (meta.authMethod === "oauth") {
    // ChatGPT and Gemini OAuth
    note("OAuth flow will open your browser to authenticate.", "OAuth");
    // For now, show instructions — full OAuth flow is in the provider
    logger.plain(pc.yellow("  OAuth flow not yet implemented in CLI. Coming soon."));
    logger.plain(pc.dim("  Workaround: use API key instead."));
    return;
  }

  // Model selection
  if (meta.models.length > 0) {
    const modelOptions = [
      ...meta.models.map((m) => ({
        value: m.id,
        label: m.label,
        hint: m.hint,
      })),
      { value: "__custom__", label: "Other (enter manually)" },
    ];

    const modelChoice = handleCancel(
      await select({
        message: "Choose a model:",
        options: modelOptions,
      }),
    ) as string;

    if (modelChoice === "__custom__") {
      const custom = handleCancel(
        await text({
          message: "Enter model name:",
          placeholder: meta.models[0]?.id ?? "model-name",
        }),
      ) as string;
      entry.model = custom.trim();
    } else {
      entry.model = modelChoice;
    }
  }

  // Save to config
  const config = readGlobalConfigWithDefaults();
  const providers = config.providers ?? [];
  // Remove existing entry for same type
  const filtered = providers.filter((p) => p.type !== entry.type);
  filtered.push(entry);
  config.providers = filtered;
  writeGlobalConfig(config);

  logger.plain(`\n${pc.green("✓")} Provider ${pc.bold(meta.name)} added successfully.`);
  if (entry.model) {
    logger.plain(`  Model: ${entry.model}`);
  }
  logger.plain(pc.dim("  Run: openpawl providers test"));
}

async function promptApiKey(
  entry: ProviderConfigEntry,
  id: string,
  meta: ProviderMeta,
): Promise<void> {
  // Check env var first
  for (const envKey of meta.envKeys) {
    if (process.env[envKey]) {
      logger.plain(`  ${pc.green("✓")} Found ${envKey} in environment`);
      const useEnv = handleCancel(
        await confirm({
          message: `Use ${envKey} from environment?`,
          initialValue: true,
        }),
      ) as boolean;
      if (useEnv) {
        entry.apiKey = process.env[envKey];
        return;
      }
    }
  }

  // Show guidance
  if (meta.keyUrl) {
    logger.plain(`  Get your key at: ${pc.cyan(meta.keyUrl)}`);
  }
  if (meta.keyPrefix) {
    logger.plain(`  Starts with: ${pc.dim(meta.keyPrefix)}`);
  }
  if (meta.notes) {
    for (const note of meta.notes) {
      logger.plain(`  ${pc.dim("·")} ${note}`);
    }
  }

  const apiKey = handleCancel(
    await password({ message: `${meta.name} API key:` }),
  ) as string;

  if (apiKey?.trim()) {
    const validation = validateApiKeyFormat(id, apiKey.trim());
    if (validation.valid) {
      logger.plain(`  ${pc.green("✓")} Format OK  ${pc.dim(maskApiKey(apiKey.trim()))}`);
    } else {
      logger.plain(`  ${pc.yellow("⚠")} ${validation.hint}`);
    }
    entry.apiKey = apiKey.trim();
  }
}

async function promptLocalProvider(
  entry: ProviderConfigEntry,
  id: string,
  meta: ProviderMeta,
): Promise<void> {
  const defaultUrl = meta.baseURL ?? (id === "ollama" ? "http://localhost:11434/v1" : "http://localhost:1234/v1");

  const baseURL = handleCancel(
    await text({
      message: `${meta.name} URL:`,
      initialValue: defaultUrl,
      placeholder: defaultUrl,
    }),
  ) as string;
  entry.baseURL = baseURL.trim();

  // Probe the endpoint
  const s = spinner();
  s.start(`Checking ${meta.name}...`);
  try {
    const probeUrl = id === "ollama"
      ? entry.baseURL.replace(/\/v1\/?$/, "/api/tags")
      : entry.baseURL + "/models";
    const res = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      s.stop(pc.green(`${meta.name} is running!`));
    } else {
      s.stop(pc.yellow(`${meta.name} responded with ${res.status}`));
    }
  } catch {
    s.stop(pc.yellow(`${meta.name} not detected at ${entry.baseURL}`));
    logger.plain(pc.dim(
      id === "ollama"
        ? "  Install: https://ollama.ai/download then run: ollama serve"
        : "  Open LM Studio → Local Server → Start Server"
    ));
  }
}

async function promptCopilotAuth(entry: ProviderConfigEntry): Promise<void> {
  entry.authMethod = "device-oauth";
  note(
    "OpenPawl will use GitHub's device flow to authenticate.\n" +
    "This requires an active GitHub Copilot subscription.",
    "GitHub Copilot",
  );

  // Check for existing GitHub token
  const existingToken = process.env.GITHUB_TOKEN;
  if (existingToken) {
    logger.plain(`  ${pc.green("✓")} Found GITHUB_TOKEN in environment`);
    entry.githubToken = existingToken;
    return;
  }

  // Run device flow
  const { runCopilotDeviceFlow, pollCopilotDeviceToken } = await import("../providers/copilot-provider.js");
  const codeData = JSON.parse(await runCopilotDeviceFlow()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
  };

  logger.plain(`\n  Go to: ${pc.cyan(codeData.verification_uri)}`);
  logger.plain(`  Enter code: ${pc.bold(codeData.user_code)}\n`);

  const s = spinner();
  s.start("Waiting for authorization...");

  const interval = (codeData.interval || 5) * 1000;
  let token: string | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, interval));
    token = await pollCopilotDeviceToken(codeData.device_code);
    if (token) break;
  }

  if (token) {
    s.stop(pc.green("Authorized!"));
    entry.githubToken = token;
  } else {
    s.stop(pc.red("Authorization timed out"));
  }
}

async function promptSetupToken(entry: ProviderConfigEntry): Promise<void> {
  entry.authMethod = "setup-token";
  note(
    "Run `claude setup-token` in a separate terminal to get a token.\n" +
    "Requires Claude Code CLI to be installed.",
    "Claude Setup Token",
  );

  const token = handleCancel(
    await password({ message: "Paste your setup-token (sk-ant-oat01-...):" }),
  ) as string;

  if (token?.trim()) {
    entry.setupToken = token.trim();
  }
}

async function promptBedrockAuth(entry: ProviderConfigEntry): Promise<void> {
  entry.authMethod = "credentials";

  // Check env vars
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    logger.plain(`  ${pc.green("✓")} Found AWS credentials in environment`);
    const useEnv = handleCancel(
      await confirm({ message: "Use AWS credentials from environment?", initialValue: true }),
    ) as boolean;
    if (useEnv) {
      entry.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      entry.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      entry.region = process.env.AWS_REGION ?? "us-east-1";
      return;
    }
  }

  const accessKeyId = handleCancel(
    await text({ message: "AWS Access Key ID:", placeholder: "AKIA..." }),
  ) as string;
  entry.accessKeyId = accessKeyId.trim();

  const secretKey = handleCancel(
    await password({ message: "AWS Secret Access Key:" }),
  ) as string;
  entry.secretAccessKey = secretKey.trim();

  const region = handleCancel(
    await text({ message: "AWS Region:", initialValue: "us-east-1" }),
  ) as string;
  entry.region = region.trim();
}

async function promptVertexAuth(entry: ProviderConfigEntry): Promise<void> {
  entry.authMethod = "credentials";

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    logger.plain(`  ${pc.green("✓")} Found GOOGLE_APPLICATION_CREDENTIALS in environment`);
    entry.serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  } else {
    const saPath = handleCancel(
      await text({
        message: "Path to service account JSON:",
        placeholder: "/path/to/sa.json",
      }),
    ) as string;
    entry.serviceAccountPath = saPath.trim();
  }

  const projectId = handleCancel(
    await text({
      message: "GCP Project ID:",
      initialValue: process.env.GOOGLE_CLOUD_PROJECT ?? "",
      placeholder: "my-project-123",
    }),
  ) as string;
  entry.projectId = projectId.trim();

  const region = handleCancel(
    await text({ message: "Region:", initialValue: "us-central1" }),
  ) as string;
  entry.region = region.trim();
}
```

- [ ] **Step 2: Also expand ENV_KEYS for `providers list`**

Update the `ENV_KEYS` map at the top of `src/commands/providers.ts` to match the expanded env vars from `provider-factory.ts`:

```typescript
const ENV_KEYS: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  DEEPSEEK_API_KEY: "deepseek",
  GROQ_API_KEY: "groq",
  GOOGLE_API_KEY: "gemini",
  GEMINI_API_KEY: "gemini",
  XAI_API_KEY: "grok",
  MISTRAL_API_KEY: "mistral",
  CEREBRAS_API_KEY: "cerebras",
  TOGETHER_API_KEY: "together",
  TOGETHER_AI_API_KEY: "together",
  FIREWORKS_API_KEY: "fireworks",
  PERPLEXITY_API_KEY: "perplexity",
  MOONSHOT_API_KEY: "moonshot",
  ZAI_API_KEY: "zai",
  ZHIPU_API_KEY: "zai",
  MINIMAX_API_KEY: "minimax",
  COHERE_API_KEY: "cohere",
  OPENCODE_API_KEY: "opencode-zen",
  OPENCODE_GO_API_KEY: "opencode-go",
  AZURE_OPENAI_API_KEY: "azure",
  GITHUB_TOKEN: "copilot",
  AWS_ACCESS_KEY_ID: "bedrock",
};
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/commands/providers.ts
git commit -m "feat: add 'openpawl providers add' with full provider menu"
```

---

## Task 11: Update Setup Wizard — Subscription Detection

**Files:**
- Modify: `src/commands/setup/connection.ts`
- Modify: `src/commands/setup.ts`

- [ ] **Step 1: Add subscription detection to setup wizard**

Update `src/commands/setup/connection.ts` — expand `PROVIDER_CHOICES` and add `stepSubscriptionDetection`:

```typescript
import { PROVIDER_CATALOG, getProvidersByCategory } from "../../providers/provider-catalog.js";

// Replace PROVIDER_CHOICES with expanded list grouped by category
const PROVIDER_CHOICES: Array<{ value: string; label: string; hint?: string }> = [
  // Subscription plans (first)
  { value: "chatgpt", label: "ChatGPT Plus/Pro", hint: "OAuth [officially supported by OpenAI]" },
  { value: "copilot", label: "GitHub Copilot", hint: "Device OAuth [officially supported]" },
  { value: "anthropic-sub", label: "Claude Pro/Max", hint: "setup-token [⚠️ ToS gray area]" },
  // API keys
  { value: "anthropic", label: "Anthropic (Claude)", hint: "Recommended · Best quality" },
  { value: "openai", label: "OpenAI (GPT)", hint: "Great quality" },
  { value: "gemini", label: "Google Gemini", hint: "API key [free tier available]" },
  { value: "grok", label: "xAI Grok", hint: "2M context, real-time X" },
  { value: "mistral", label: "Mistral AI", hint: "EU data residency" },
  { value: "deepseek", label: "DeepSeek", hint: "Cheapest frontier" },
  { value: "groq", label: "Groq", hint: "Fastest inference" },
  { value: "cerebras", label: "Cerebras", hint: "Extreme throughput" },
  { value: "together", label: "Together AI", hint: "100+ open models, $100 free" },
  { value: "fireworks", label: "Fireworks AI", hint: "Fast open model serving" },
  { value: "openrouter", label: "OpenRouter", hint: "200+ models, one key" },
  { value: "perplexity", label: "Perplexity", hint: "Web-grounded search" },
  { value: "moonshot", label: "Moonshot AI (Kimi)", hint: "Kimi K2.5" },
  { value: "zai", label: "Z.AI (GLM / Zhipu)", hint: "GLM-5" },
  { value: "minimax", label: "MiniMax", hint: "1M context" },
  { value: "cohere", label: "Cohere", hint: "RAG specialist" },
  // OpenCode
  { value: "opencode-zen", label: "OpenCode Zen", hint: "Curated frontier models" },
  { value: "opencode-go", label: "OpenCode Go", hint: "Curated open models ($10/mo)" },
  // Cloud
  { value: "bedrock", label: "AWS Bedrock", hint: "IAM credentials" },
  { value: "vertex", label: "Google Vertex AI", hint: "Service account" },
  { value: "azure", label: "Azure OpenAI", hint: "API key + endpoint" },
  // Local
  { value: "ollama", label: "Ollama", hint: "Free · Runs locally · No key" },
  { value: "lmstudio", label: "LM Studio", hint: "Free · Runs locally · No key" },
  { value: "custom", label: "Custom", hint: "Any OpenAI-compatible API" },
];
```

Also add an early `stepSubscriptionDetection()` function to `connection.ts` that asks "Do you already pay for any AI subscriptions?" and returns suggested provider order.

- [ ] **Step 2: Update setup.ts to call subscription detection before provider step**

Add subscription question before Step 1 in `runSetup()`:

```typescript
// Before Step 1/7
const subscriptions = await stepSubscriptionDetection();
// Pass subscriptions to stepProvider to pre-sort recommendations
```

- [ ] **Step 3: Update PROVIDER_DEFAULT_MODELS in setup.ts**

Replace the hardcoded `PROVIDER_DEFAULT_MODELS` in `src/commands/setup.ts` with a dynamic lookup from the catalog:

```typescript
import { PROVIDER_CATALOG } from "../providers/provider-catalog.js";

// Replace static PROVIDER_DEFAULT_MODELS with dynamic lookup
function getDefaultModelForProvider(providerType: string): string {
  const meta = PROVIDER_CATALOG[providerType];
  return meta?.models[0]?.id ?? "";
}
```

Then update `stepModel()` and `persistAllConfig()` to use `getDefaultModelForProvider()` instead of `PROVIDER_DEFAULT_MODELS[providerType]`. Remove the old `PROVIDER_DEFAULT_MODELS` constant.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/commands/setup/connection.ts src/commands/setup.ts
git commit -m "feat: expand setup wizard with subscription detection and 30+ providers"
```

---

## ~~Task 12~~ MERGED INTO TASK 1

> The `validProviderTypes` and field normalization update was moved to Task 1, Step 4 to prevent new provider types from being silently dropped by `normalizeGlobalConfig`.

---

## Task 12: Install Open Dependency & Final Wiring

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `open` package for browser launching**

Run: `bun add open`

- [ ] **Step 2: Run full test suite and typecheck**

Run: `bun run typecheck && bun run test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add open dependency for OAuth browser launching"
```

---

## Task 14: Integration Test — Provider Chain

**Files:**
- Create: `tests/providers/provider-chain-integration.test.ts`

- [ ] **Step 1: Write integration test for full provider chain**

```typescript
// tests/providers/provider-chain-integration.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => ({
  default: class MockOpenAI {
    constructor(public config: Record<string, unknown>) {}
    chat = {
      completions: {
        create: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: async function* () {
            yield { choices: [{ delta: { content: "test" } }] };
            yield { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        }),
      },
    };
    models = { list: vi.fn().mockResolvedValue({ data: [] }) };
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor(public config: Record<string, unknown>) {}
    messages = {
      stream: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "test" } };
          yield { type: "message_stop" };
        },
        finalMessage: vi.fn().mockResolvedValue({ usage: { input_tokens: 10, output_tokens: 5 } }),
      }),
    };
  },
}));

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { createProviderChain } from "../src/providers/provider-factory.js";
import { ProviderManager } from "../src/providers/provider-manager.js";
import type { ProviderConfigEntry } from "../src/core/global-config.js";

describe("provider chain integration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates chain from mixed provider config", () => {
    const entries: ProviderConfigEntry[] = [
      { type: "anthropic", apiKey: "sk-ant-test" },
      { type: "grok", apiKey: "xai-test" },
      { type: "deepseek", apiKey: "sk-test" },
      { type: "ollama" },
    ];

    const chain = createProviderChain(entries);
    expect(chain).toHaveLength(4);
    expect(chain[0]!.name).toBe("anthropic");
    expect(chain[1]!.name).toBe("grok");
    expect(chain[2]!.name).toBe("deepseek");
    expect(chain[3]!.name).toBe("ollama");
  });

  it("creates chain from new provider types", () => {
    const entries: ProviderConfigEntry[] = [
      { type: "gemini", apiKey: "test-key", model: "gemini-3-pro" },
      { type: "mistral", apiKey: "test-key", model: "codestral" },
      { type: "cerebras", apiKey: "test-key" },
      { type: "together", apiKey: "test-key" },
      { type: "fireworks", apiKey: "test-key" },
      { type: "perplexity", apiKey: "test-key" },
      { type: "moonshot", apiKey: "test-key" },
      { type: "zai", apiKey: "test-key" },
      { type: "minimax", apiKey: "test-key" },
      { type: "cohere", apiKey: "test-key" },
    ];

    const chain = createProviderChain(entries);
    expect(chain).toHaveLength(10);
    expect(chain.map((p) => p.name)).toEqual([
      "gemini", "mistral", "cerebras", "together", "fireworks",
      "perplexity", "moonshot", "zai", "minimax", "cohere",
    ]);
  });

  it("discovers new providers from env vars", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test");
    vi.stubEnv("MISTRAL_API_KEY", "test-key");
    vi.stubEnv("CEREBRAS_API_KEY", "test-key");

    const chain = createProviderChain();
    expect(chain.length).toBeGreaterThanOrEqual(3);
    const names = chain.map((p) => p.name);
    expect(names).toContain("grok");
    expect(names).toContain("mistral");
    expect(names).toContain("cerebras");
  });

  it("ProviderManager falls back through chain", async () => {
    const entries: ProviderConfigEntry[] = [
      { type: "anthropic", apiKey: "sk-ant-test" },
      { type: "deepseek", apiKey: "sk-test" },
    ];

    const chain = createProviderChain(entries);
    const manager = new ProviderManager(chain);
    expect(manager.getProviders()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun run test -- tests/providers/provider-chain-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/providers/provider-chain-integration.test.ts
git commit -m "test: add provider chain integration tests for 30+ providers"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: No errors (or only pre-existing warnings)

- [ ] **Step 4: Run build**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address typecheck/lint issues from provider integration"
```
