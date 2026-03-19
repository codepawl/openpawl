import { getLangfuse } from "./langfuse.js";
import type { StreamProvider } from "../providers/provider.js";
import type { StreamOptions, StreamChunk } from "../providers/stream-types.js";

export function createTracedProvider(
  provider: StreamProvider,
  sessionId: string,
): StreamProvider {
  const lf = getLangfuse();
  if (!lf) return provider; // no-op when Langfuse not configured

  return {
    name: provider.name,
    healthCheck: () => provider.healthCheck(),
    isAvailable: () => provider.isAvailable(),
    setAvailable: (v: boolean) => provider.setAvailable(v),

    async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
      const generation = lf.generation({
        name: `${provider.name}/stream`,
        model: options?.model ?? "unknown",
        input: { prompt: prompt.slice(0, 500) }, // truncate to avoid huge payloads
        metadata: {
          sessionId,
          provider: provider.name,
          temperature: options?.temperature,
        },
      });

      const start = Date.now();
      const chunks: string[] = [];

      try {
        for await (const chunk of provider.stream(prompt, options)) {
          chunks.push(chunk.content);
          yield chunk;

          if (chunk.done && chunk.usage) {
            generation.end({
              output: chunks.join("").slice(0, 1000), // truncate output too
              usage: {
                input: chunk.usage.promptTokens,
                output: chunk.usage.completionTokens,
              },
              level: "DEFAULT",
              completionStartTime: new Date(start),
            });
          }
        }
      } catch (e) {
        generation.end({
          level: "ERROR",
          statusMessage: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
  };
}
