/**
 * Config detection — checks provider/API key configuration
 * and shows one-time inline warnings if not configured.
 */
import type { AppLayout } from "./layout.js";

export interface ConfigState {
  hasProvider: boolean;
  providerName: string;
  isConnected: boolean;
  error: string | null;
}

/**
 * Detect provider configuration by probing the global provider manager.
 */
export async function detectConfig(): Promise<ConfigState> {
  try {
    const { getGlobalProviderManager } = await import(
      "../providers/provider-factory.js"
    );
    const mgr = getGlobalProviderManager();
    const providers = mgr.getProviders();

    if (providers.length === 0) {
      return {
        hasProvider: false,
        providerName: "",
        isConnected: false,
        error: "No provider configured",
      };
    }

    const first = providers[0]!;
    let isConnected = false;
    let error: string | null = null;

    try {
      const ok = await first.healthCheck();
      isConnected = !!ok;
    } catch (err) {
      error = err instanceof Error ? err.message : "Connection failed";
      if (error.includes("401") || error.includes("auth")) {
        error = "API key invalid";
      }
    }

    return {
      hasProvider: true,
      providerName: first.name,
      isConnected,
      error,
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
 * Called once after splash, before the user starts typing.
 */
export function showConfigWarning(
  configState: ConfigState,
  layout: AppLayout,
): void {
  if (configState.isConnected) return; // all good

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
