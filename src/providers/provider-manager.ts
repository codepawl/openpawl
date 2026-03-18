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
        return;
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
          throw providerErr;
        }

        errors.push(providerErr);

        const next = this.providers[i + 1];
        if (next) {
          this.stats.fallbacksTriggered++;
          logger.warn(`${provider.name} unavailable — switching to ${next.name}`);
        }
      }
    }

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
