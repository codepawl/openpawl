/**
 * Vitest global setup.
 *
 * Keep unit tests deterministic regardless of developer-local `.env`.
 * TeamClaw uses OpenClaw as the single LLM/worker gateway.
 */

process.env["OPENCLAW_WORKER_URL"] = process.env["OPENCLAW_WORKER_URL"] ?? "http://localhost:8001";
process.env["OPENCLAW_TOKEN"] = process.env["OPENCLAW_TOKEN"] ?? "test-token";

