/**
 * GitHub Copilot provider — Device OAuth flow + OpenAI-compatible completions.
 *
 * Auth: Exchange GitHub token for Copilot token (~30min TTL, auto-refresh).
 * Endpoint: https://api.githubcopilot.com/chat/completions (OpenAI-compatible SSE)
 */

import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { VERSION } from "../version.js";
import { logger } from "../core/logger.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_COMPLETIONS_URL =
  "https://api.githubcopilot.com/chat/completions";
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEFAULT_MODEL = "claude-sonnet-4.6";
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
    return (
      !this.copilotToken ||
      Date.now() >= this.copilotTokenExpiry - REFRESH_BUFFER_MS
    );
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
        "User-Agent": `OpenPawl/${VERSION}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[copilot] token exchange failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
      throw new ProviderError({
        provider: "copilot",
        code: "COPILOT_TOKEN_EXPIRED",
        message: `Copilot token exchange failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
        statusCode: res.status,
        isFallbackTrigger: true,
      });
    }

    const data = (await res.json()) as { token: string; expires_at: number };
    this.copilotToken = data.token;
    this.copilotTokenExpiry = data.expires_at * 1000;
    logger.debug(
      "[copilot] token refreshed, expires at " +
        new Date(this.copilotTokenExpiry).toISOString(),
    );
  }

  private async ensureToken(): Promise<string> {
    if (!this.needsRefresh() && this.copilotToken) {
      return this.copilotToken;
    }
    logger.debug(`[copilot] token refresh needed (has github token: ${!!this.githubToken}, copilot token expired: ${this.needsRefresh()})`);
    if (!this.refreshing) {
      this.refreshing = this.refreshCopilotToken().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return this.copilotToken!;
  }

  async *stream(
    prompt: string,
    options?: StreamOptions,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const token = await this.ensureToken();
    const model = options?.model ?? this.model;

    const messages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt)
      messages.push({ role: "system", content: options.systemPrompt });
    messages.push({ role: "user", content: prompt });

    logger.debug(`[copilot] streaming with model=${model}`);

    const res = await fetch(COPILOT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.99.0",
        "Editor-Plugin-Version": "copilot-chat/0.24.0",
        "User-Agent": "GitHubCopilotChat/0.24.0",
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
      const errText = await res.text().catch(() => "");
      logger.warn(`[copilot] stream failed: HTTP ${res.status} — ${errText.slice(0, 300)}`);
      if (res.status === 401) {
        try {
          await this.refreshCopilotToken();
        } catch {
          /* ignore refresh failure */
        }
      }
      throw new ProviderError({
        provider: "copilot",
        code:
          res.status === 401
            ? "COPILOT_TOKEN_EXPIRED"
            : res.status === 429
              ? "RATE_LIMITED"
              : "STREAM_FAILED",
        message: `Copilot API error: ${res.status} ${errText.slice(0, 200)}`,
        statusCode: res.status,
        isFallbackTrigger: true,
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
            if (content) yield { content, done: false };
          } catch {
            /* skip malformed chunks */
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

/** Run the GitHub device OAuth flow. Returns JSON string with device_code, user_code, verification_uri. */
export async function runCopilotDeviceFlow(): Promise<string> {
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
  if (!codeRes.ok)
    throw new Error(`Device code request failed: ${codeRes.status}`);
  const codeData = await codeRes.json();
  return JSON.stringify(codeData);
}

/** Poll for device flow token. Returns access_token or null if still pending. */
export async function pollCopilotDeviceToken(
  deviceCode: string,
): Promise<string | null> {
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
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}
