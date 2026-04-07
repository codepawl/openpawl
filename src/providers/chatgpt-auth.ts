/**
 * ChatGPT Plus/Pro OAuth 2.0 PKCE flow.
 */

import { createHash, randomBytes } from "node:crypto";
import { ok, err, type Result } from "neverthrow";
import open from "open";
import { startOAuthCallbackServer } from "./oauth-helpers.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://127.0.0.1:1455/callback";
const CALLBACK_PORT = 1455;

export interface ChatGPTTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthError {
  message: string;
  code?: string;
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return { verifier, challenge };
}

export function buildChatGPTAuthUrl(codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "openid profile email offline_access",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeChatGPTToken(
  code: string,
  codeVerifier: string,
): Promise<Result<ChatGPTTokens, AuthError>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
  });

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (e) {
    return err({ message: `Network error: ${String(e)}` });
  }

  if (!res.ok) {
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string };
      code = data.error;
    } catch {
      // ignore parse error
    }
    return err({ message: `Token exchange failed: ${res.status}`, code });
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || !data.refresh_token) {
    return err({ message: "Missing tokens in response" });
  }

  return ok({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  });
}

export async function refreshChatGPTToken(
  refreshToken: string,
): Promise<Result<ChatGPTTokens, AuthError>> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (e) {
    return err({ message: `Network error: ${String(e)}` });
  }

  if (!res.ok) {
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string };
      code = data.error;
    } catch {
      // ignore parse error
    }
    return err({ message: `Token refresh failed: ${res.status}`, code });
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || !data.refresh_token) {
    return err({ message: "Missing tokens in response" });
  }

  return ok({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  });
}

export async function runChatGPTOAuthFlow(): Promise<Result<ChatGPTTokens, AuthError>> {
  const { verifier, challenge } = generatePKCE();
  const authUrl = buildChatGPTAuthUrl(challenge);

  const { promise, server } = startOAuthCallbackServer(CALLBACK_PORT, "/callback");

  await open(authUrl);

  let code: string;
  try {
    code = await promise;
  } catch (e) {
    server.close();
    return err({ message: `OAuth callback error: ${String(e)}` });
  }

  return exchangeChatGPTToken(code, verifier);
}
