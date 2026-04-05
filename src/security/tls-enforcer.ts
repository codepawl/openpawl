/**
 * Enforce TLS for all outgoing API calls. HTTP only allowed for localhost.
 */

import { Result, ok, err } from "neverthrow";

export class TlsEnforcer {
  validateUrl(url: string): Result<void, { type: string; cause: string }> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") return ok(undefined);
      if (parsed.protocol === "http:" && isLocalhost(parsed.hostname)) return ok(undefined);
      return err({ type: "tls_required", cause: `HTTP not allowed for ${parsed.hostname}. Use HTTPS.` });
    } catch {
      return err({ type: "invalid_url", cause: `Invalid URL: ${url}` });
    }
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";
}
