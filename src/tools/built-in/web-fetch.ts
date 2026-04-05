/**
 * web_fetch — fetch a URL and return content.
 */

import { z } from "zod";
import { ok, err } from "neverthrow";
import type { ToolDefinition, ToolOutput } from "../types.js";

const inputSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  maxBytes: z.number().optional().default(100_000).describe("Max response bytes"),
});

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    displayName: "Fetch URL",
    description: "Fetch content from a URL. Returns the response body as text.",
    category: "web",
    inputSchema,
    defaultPermission: "auto",
    riskLevel: "safe",
    destructive: false,
    requiresNetwork: true,
    source: "built-in",
    execute: async (input, context) => {
      const { url, maxBytes } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);

        if (context.abortSignal) {
          context.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }

        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!resp.ok) {
          return err({ type: "execution_failed", toolName: "web_fetch", cause: `HTTP ${resp.status}: ${resp.statusText}` });
        }

        const contentType = resp.headers.get("content-type") ?? "text/plain";
        const isText = contentType.includes("text") || contentType.includes("json") || contentType.includes("xml");

        if (!isText) {
          return err({ type: "execution_failed", toolName: "web_fetch", cause: `Non-text content type: ${contentType}` });
        }

        let body = await resp.text();
        if (body.length > maxBytes) {
          body = body.slice(0, maxBytes) + `\n[... truncated at ${maxBytes} bytes]`;
        }

        const output: ToolOutput = {
          success: true,
          data: { url, contentType, length: body.length },
          summary: `Fetched ${url} (${body.length} bytes, ${contentType})`,
          fullOutput: body,
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "web_fetch", cause: String(e) });
      }
    },
  };
}
