import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { StreamOptions } from "../providers/stream-types.js";
import { ProviderError } from "../providers/types.js";
import { createProxyService } from "./ProxyService.js";
import type { ProxyPluginOptions, ProxyStreamQuery } from "./types.js";

async function proxyPluginImpl(
  fastify: FastifyInstance,
  opts: ProxyPluginOptions,
): Promise<void> {
  const basePath = opts.basePath ?? "/proxy";
  const proxyService = createProxyService();

  fastify.addHook("onClose", async () => {
    await proxyService.shutdown();
  });

  // -------------------------------------------------------------------------
  // GET {basePath}/stream — SSE streaming
  // -------------------------------------------------------------------------
  fastify.get<{ Querystring: ProxyStreamQuery }>(
    `${basePath}/stream`,
    async (req, reply) => {
      const { prompt, options: optionsJson } = req.query;

      if (!prompt || !prompt.trim()) {
        return reply.status(400).send({ error: "prompt query parameter is required" });
      }

      let parsedOptions: StreamOptions | undefined;
      if (optionsJson) {
        try {
          parsedOptions = JSON.parse(optionsJson) as StreamOptions;
        } catch {
          return reply.status(400).send({ error: "Invalid JSON in options parameter" });
        }
      }

      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const abortController = new AbortController();
      req.raw.on("close", () => {
        abortController.abort();
      });

      const streamOptions: StreamOptions = {
        ...parsedOptions,
        signal: abortController.signal,
      };

      let chunkIndex = 0;
      try {
        for await (const chunk of proxyService.stream(prompt, streamOptions)) {
          if (abortController.signal.aborted) break;
          const event = JSON.stringify({
            event: "chunk",
            data: { content: chunk.content, index: chunkIndex },
          });
          raw.write(`data: ${event}\n\n`);
          chunkIndex++;
        }

        if (!abortController.signal.aborted) {
          const doneEvent = JSON.stringify({
            event: "done",
            data: { totalChunks: chunkIndex },
          });
          raw.write(`data: ${doneEvent}\n\n`);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const code = err instanceof ProviderError
            ? err.code
            : "UNKNOWN";
          const message = err instanceof Error ? err.message : String(err);
          const errorEvent = JSON.stringify({
            event: "error",
            data: { code, message },
          });
          raw.write(`data: ${errorEvent}\n\n`);
        }
      } finally {
        raw.end();
      }

      reply.hijack();
    },
  );

  // -------------------------------------------------------------------------
  // GET {basePath}/health
  // -------------------------------------------------------------------------
  fastify.get(`${basePath}/health`, async () => {
    return proxyService.health();
  });

  // -------------------------------------------------------------------------
  // POST {basePath}/reconnect
  // -------------------------------------------------------------------------
  fastify.post(`${basePath}/reconnect`, async (_req, reply) => {
    try {
      const result = await proxyService.reconnect();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, message });
    }
  });
}

export const proxyPlugin = fp(proxyPluginImpl, {
  name: "teamclaw-proxy",
});
