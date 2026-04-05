/**
 * API key masking and credential detection for safe display/logging.
 */

const CREDENTIAL_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{10,}/g,
  /\bsk-or-[A-Za-z0-9_-]{10,}/g,
  /\bgsk_[A-Za-z0-9_-]{10,}/g,
  /\bxai-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{20,}/g,
];

/** Mask a credential for display: show first 6 + last 4, mask middle. */
export function maskCredential(value: string): string {
  if (value.length < 8) return "•".repeat(value.length || 3);
  if (value.length < 14) return value.slice(0, 3) + "..." + value.slice(-2);
  return value.slice(0, 6) + "..." + value.slice(-4);
}

/** Check if a string looks like a credential. */
export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(value);
  });
}

/** Redact credentials found in a larger text string. */
export function redactCredentials(text: string): string {
  let result = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => maskCredential(match));
  }
  return result;
}
