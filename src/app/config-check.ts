/**
 * Config detection — tiered provider validation.
 *
 * Tier 1: Instant config check (no network, no credential store)
 * Tier 2: Background health ping (lightweight network call after first paint)
 * Tier 3: Real validation on first LLM call (implicit, handled by engine/errors)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppLayout } from "./layout.js";
import type { ConnectionStatus } from "../core/connection-state.js";

export interface ConfigState {
  hasProvider: boolean;
  providerName: string;
  isConnected: boolean;
  error: string | null;
}

// ── Tier 1: Instant config check (synchronous, no network) ─────────────

/**
 * Check if a provider is configured with an API key, purely from
 * config file and environment variables. No network, no credential store init.
 * Returns provider name and whether an API key is present.
 */
export function checkConfigInstant(): { hasProvider: boolean; providerName: string; hasKey: boolean } {
  // Check config file
  try {
    const cfgPath = join(homedir(), ".openpawl", "config.json");
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
      const providers = raw?.providers;
      if (Array.isArray(providers) && providers.length > 0) {
        // Prefer activeProvider entry, fall back to first in array
        const activeId = raw?.activeProvider;
        const first = (activeId && providers.find((p: Record<string, unknown>) => p?.type === activeId)) || providers[0];
        const type = first?.type ?? "";
        const name = first?.name ?? type;
        // Check inline API key or hasCredential flag
        const hasInlineKey = !!(first?.apiKey || first?.oauthToken || first?.githubToken || first?.copilotToken);
        const hasCredFlag = !!first?.hasCredential;

        // Also check env var for this provider type
        const envKey = getEnvKeyForProvider(type);
        const hasEnvKey = !!(envKey && process.env[envKey]);

        return {
          hasProvider: true,
          providerName: name,
          hasKey: hasInlineKey || hasCredFlag || hasEnvKey,
        };
      }
    }
  } catch { /* config read failed — fall through to env check */ }

  // Check env vars for known providers
  const envProviders: [string, string][] = [
    ["ANTHROPIC_API_KEY", "anthropic"],
    ["OPENAI_API_KEY", "openai"],
    ["OPENROUTER_API_KEY", "openrouter"],
    ["DEEPSEEK_API_KEY", "deepseek"],
    ["GROQ_API_KEY", "groq"],
    ["GOOGLE_API_KEY", "gemini"],
    ["XAI_API_KEY", "grok"],
    ["MISTRAL_API_KEY", "mistral"],
  ];

  for (const [envVar, name] of envProviders) {
    if (process.env[envVar]) {
      return { hasProvider: true, providerName: name, hasKey: true };
    }
  }

  return { hasProvider: false, providerName: "", hasKey: false };
}

function getEnvKeyForProvider(type: string): string | null {
  const map: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: "GOOGLE_API_KEY",
    grok: "XAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    ollama: "", // no key needed
    lmstudio: "", // no key needed
  };
  return map[type] ?? null;
}

// ── Tier 2: Background health ping ──────────────────────────────────────

/**
 * Lightweight provider health ping. Calls the provider's healthCheck()
 * with a timeout. Retries once on timeout to handle proxy TCP cold-start.
 */
export async function pingProvider(timeoutMs = 5000): Promise<{ status: ConnectionStatus; error?: string }> {
  const attempt = async (): Promise<{ status: ConnectionStatus; error?: string }> => {
    try {
      const { getGlobalProviderManager } = await import(
        "../providers/provider-factory.js"
      );
      const mgr = await getGlobalProviderManager();
      const providers = mgr.getProviders();

      if (providers.length === 0) {
        return { status: "no_key" };
      }

      const first = providers[0]!;

      // Health check with abort timeout
      const result = await Promise.race([
        first.healthCheck().then((ok) => (ok ? "connected" as const : "auth_failed" as const)),
        new Promise<"offline">((resolve) => setTimeout(() => resolve("offline"), timeoutMs)),
      ]);

      return { status: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("403") || msg.includes("auth") || msg.includes("Unauthorized")) {
        return { status: "auth_failed", error: msg };
      }
      return { status: "offline", error: msg };
    }
  };

  const result = await attempt();
  // Retry once on timeout (no error = timeout race won, not a real failure).
  // Handles proxy TCP cold-start where first request hangs but second succeeds.
  if (result.status === "offline" && !result.error) {
    return attempt();
  }
  return result;
}

// ── Legacy: full detectConfig (used by models:refreshed handler) ────────

/**
 * Full provider detection including health check.
 * Still used by the provider registry refresh handler.
 */
export async function detectConfig(): Promise<ConfigState> {
  const quick = await detectConfigQuick();
  if (!quick.hasProvider) return quick;

  try {
    const { getGlobalProviderManager } = await import(
      "../providers/provider-factory.js"
    );
    const mgr = await getGlobalProviderManager();
    const first = mgr.getProviders()[0]!;
    const ok = await first.healthCheck();
    return { ...quick, isConnected: !!ok };
  } catch (err) {
    let error = err instanceof Error ? err.message : "Connection failed";
    if (error.includes("401") || error.includes("auth")) {
      error = "API key invalid";
    }
    return { ...quick, error };
  }
}

/**
 * Fast provider detection — creates provider manager but skips health check.
 * Used by wizard flow and models:refreshed handler.
 */
export async function detectConfigQuick(): Promise<ConfigState> {
  try {
    const { getGlobalProviderManager } = await import(
      "../providers/provider-factory.js"
    );
    const mgr = await getGlobalProviderManager();
    const providers = mgr.getProviders();

    if (providers.length === 0) {
      return {
        hasProvider: false,
        providerName: "",
        isConnected: false,
        error: "No provider configured",
      };
    }

    return {
      hasProvider: true,
      providerName: providers[0]!.name,
      isConnected: false,
      error: null,
    };
  } catch {
    return {
      hasProvider: false,
      providerName: "",
      isConnected: false,
      error: "Failed to initialize providers",
    };
  }
}

/**
 * Show one-time config warning if provider isn't properly configured.
 */
export function showConfigWarning(
  configState: ConfigState,
  layout: AppLayout,
): void {
  if (configState.isConnected) return;

  if (!configState.hasProvider) {
    layout.messages.addMessage({
      role: "system",
      content:
        "No provider configured.\n" +
        "   Run:  /settings provider anthropic\n" +
        "   Then: /settings apikey sk-ant-...\n" +
        "   Or:   set ANTHROPIC_API_KEY environment variable",
      timestamp: new Date(),
    });
  } else if (configState.error) {
    layout.messages.addMessage({
      role: "error",
      content:
        `${configState.error}\n` +
        "   Run: /settings to check your configuration",
      timestamp: new Date(),
    });
  }
}
