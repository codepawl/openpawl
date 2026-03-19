import { Langfuse } from "langfuse";

let _langfuse: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;

  if (!secretKey || !publicKey) return null;

  if (!_langfuse) {
    _langfuse = new Langfuse({
      secretKey,
      publicKey,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
      flushAt: 20,
      flushInterval: 5000,
    });
  }
  return _langfuse;
}

export async function flushLangfuse(): Promise<void> {
  await _langfuse?.flushAsync();
}

// Reset for testing
export function resetLangfuse(): void {
  _langfuse = null;
}
