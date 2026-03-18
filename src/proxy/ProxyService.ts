import type { StreamChunk, StreamOptions } from "../providers/stream-types.js";
import type { ProxyHealthResponse, ProxyReconnectResponse } from "./types.js";
import { isMockLlmEnabled, generateMockResponse } from "../core/mock-llm.js";
import { streamWithCache } from "../cache/cache-interceptor.js";
import { ProviderManager, HealthMonitor } from "../providers/index.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";

export class ProxyService {
  readonly providerManager: ProviderManager;
  readonly healthMonitor: HealthMonitor;
  private readonly startTime: number;

  constructor(providerManager: ProviderManager, healthMonitor: HealthMonitor) {
    this.providerManager = providerManager;
    this.healthMonitor = healthMonitor;
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
      connected: true,
      gatewayUrl: "provider-manager",
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

export function getProviderManager(): ProviderManager | null {
  return instance?.providerManager ?? null;
}

export function getHealthMonitor(): HealthMonitor | null {
  return instance?.healthMonitor ?? null;
}

export function createProxyService(): ProxyService {
  if (!instance) {
    const manager = getGlobalProviderManager();
    const providers = [...manager.getProviders()];
    const monitor = new HealthMonitor(providers);
    instance = new ProxyService(manager, monitor);
  }
  return instance;
}
