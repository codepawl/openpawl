#!/usr/bin/env bun
/**
 * Provider integration test suite.
 *
 * Usage:
 *   bun run tsx src/testing/provider-test.ts --all
 *   bun run tsx src/testing/provider-test.ts --provider ollama
 *   bun run tsx src/testing/provider-test.ts --dry-run
 *   bun run tsx src/testing/provider-test.ts --provider ollama --dry-run
 */

import pc from "picocolors";
import { readGlobalConfigWithDefaults, type ProviderConfigEntry } from "../core/global-config.js";
import { PROVIDER_CATALOG, type ProviderMeta } from "../providers/provider-catalog.js";
import { fetchModelsForProvider } from "../providers/model-fetcher.js";
import { providerFromConfig } from "../providers/provider-factory.js";
import type { StreamProvider } from "../providers/provider.js";
import { ICONS } from "../tui/constants/icons.js";

// ── CLI arg parsing ─────────────────────────────────────────────────────────

interface TestArgs {
  provider?: string;
  all: boolean;
  dryRun: boolean;
}

function parseArgs(): TestArgs {
  const args = process.argv.slice(2);
  const result: TestArgs = { all: false, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider" && args[i + 1]) {
      result.provider = args[++i];
    } else if (arg === "--all") {
      result.all = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    }
  }

  if (!result.provider && !result.all) {
    result.all = true; // default to --all
  }

  return result;
}

// ── Check result types ──────────────────────────────────────────────────────

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface CheckResult {
  status: CheckStatus;
  message: string;
}

function ok(message: string): CheckResult { return { status: "pass", message }; }
function fail(message: string): CheckResult { return { status: "fail", message }; }
function warn(message: string): CheckResult { return { status: "warn", message }; }
function skip(message: string): CheckResult { return { status: "skip", message }; }

function icon(status: CheckStatus): string {
  switch (status) {
    case "pass": return pc.green(ICONS.success);
    case "fail": return pc.red(ICONS.error);
    case "warn": return pc.yellow(ICONS.warning);
    case "skip": return pc.dim("-");
  }
}

function printCheck(result: CheckResult): void {
  console.log(`  ${icon(result.status)} ${result.message}`);
}

// ── Check 1: Config validation ──────────────────────────────────────────────

function checkConfig(entry: ProviderConfigEntry, meta: ProviderMeta | undefined): CheckResult {
  const isLocal = meta?.category === "local" || entry.type === "ollama" || entry.type === "lmstudio";
  const isOpenCode = entry.type === "opencode-zen" || entry.type === "opencode-go";
  const isCloud = meta?.category === "cloud";

  if (isLocal || isOpenCode) {
    // Local providers don't need an API key
    return ok("Config valid (no API key required)");
  }

  if (isCloud) {
    // Cloud providers need credentials, not just apiKey
    const hasCreds = entry.accessKeyId || entry.serviceAccountPath || entry.hasCredential;
    return hasCreds ? ok("Config valid (cloud credentials)") : fail("Missing cloud credentials");
  }

  if (!entry.apiKey) {
    return fail("Missing apiKey");
  }

  // Validate key prefix if known
  if (meta?.keyPrefix && !entry.apiKey.startsWith(meta.keyPrefix)) {
    return warn(`API key doesn't start with expected prefix "${meta.keyPrefix}"`);
  }

  return ok("Config valid");
}

// ── Check 2: Connection test ────────────────────────────────────────────────

async function checkConnection(entry: ProviderConfigEntry): Promise<CheckResult> {
  const start = Date.now();
  try {
    const provider = await providerFromConfig(entry);
    if (!provider) {
      return fail("Could not create provider instance");
    }

    const healthy = await withTimeout(provider.healthCheck(), 5000);
    const latency = Date.now() - start;

    return healthy
      ? ok(`Connected (${latency}ms)`)
      : fail("Health check returned false");
  } catch (err) {
    const latency = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout")) return fail(`Connection timed out (${latency}ms)`);
    return fail(`Connection failed: ${msg.slice(0, 80)}`);
  }
}

// ── Check 3: Model discovery ────────────────────────────────────────────────

async function checkModels(
  entry: ProviderConfigEntry,
  _meta: ProviderMeta | undefined,
): Promise<CheckResult> {
  try {
    const result = await fetchModelsForProvider(
      entry.type,
      entry.apiKey ?? "",
      entry.baseURL,
    );

    if (result.source === "fallback" && !result.error) {
      return warn("Model list not supported for this provider");
    }

    if (result.error) {
      return fail(`Model fetch failed: ${result.error.slice(0, 80)}`);
    }

    const count = result.models.length;
    if (count === 0) {
      return warn("No models returned");
    }

    // Show first few model names
    const names = result.models.slice(0, 3).map((m) => m.id);
    const suffix = count > 3 ? `, ... (+${count - 3})` : "";
    const activeModel = entry.model;
    const activeCheck = activeModel
      ? result.models.some((m) => m.id === activeModel)
        ? ` [${activeModel} ${ICONS.success}]`
        : ` [${activeModel} not in list]`
      : "";

    return ok(`${count} models: ${names.join(", ")}${suffix}${activeCheck}`);
  } catch (err) {
    return fail(`Model discovery error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Check 4: Simple completion ──────────────────────────────────────────────

async function checkCompletion(entry: ProviderConfigEntry): Promise<CheckResult> {
  const start = Date.now();
  try {
    const provider = await providerFromConfig(entry);
    if (!provider) return fail("Could not create provider instance");

    const response = await collectStream(provider, "Reply with exactly one word: hello");
    const elapsed = Date.now() - start;

    if (!response.text || response.text.trim().length === 0) {
      return fail(`Empty response (${(elapsed / 1000).toFixed(1)}s)`);
    }

    const preview = response.text.trim().slice(0, 50).replace(/\n/g, " ");
    const tokenInfo = response.tokens > 0 ? `, ${response.tokens} tok` : "";
    return ok(`Completion OK (${(elapsed / 1000).toFixed(1)}s${tokenInfo}) ${pc.dim(`"${preview}"`)}`);
  } catch (err) {
    const elapsed = Date.now() - start;
    return fail(`Completion failed (${(elapsed / 1000).toFixed(1)}s): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Check 5: Streaming ──────────────────────────────────────────────────────

async function checkStreaming(entry: ProviderConfigEntry): Promise<CheckResult> {
  try {
    const provider = await providerFromConfig(entry);
    if (!provider) return fail("Could not create provider instance");

    const ttfc = await measureTTFC(provider, "Reply with exactly one word: hello");

    return ok(`Streaming OK (TTFC: ${ttfc}ms)`);
  } catch (err) {
    return fail(`Streaming failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Provider-specific checks ────────────────────────────────────────────────

async function checkProviderSpecific(entry: ProviderConfigEntry): Promise<CheckResult | null> {
  if (entry.type === "ollama" || entry.type === "lmstudio") {
    const baseUrl = entry.baseURL ?? (entry.type === "ollama" ? "http://localhost:11434" : "http://localhost:1234");
    try {
      const endpoint = entry.type === "ollama" ? `${baseUrl}/api/tags` : `${baseUrl}/v1/models`;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
      return res.ok
        ? ok(`Local server running at ${baseUrl}`)
        : fail(`Local server returned HTTP ${res.status}`);
    } catch {
      return fail(`Local server not reachable at ${baseUrl}`);
    }
  }

  if (entry.type === "opencode-go" || entry.type === "opencode-zen") {
    const baseUrl = entry.baseURL ?? (entry.type === "opencode-go"
      ? "https://opencode.ai/zen/go/v1"
      : "https://opencode.ai/zen/v1");
    try {
      const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
      return res.ok
        ? ok(`Proxy endpoint reachable at ${baseUrl}`)
        : warn(`Proxy returned HTTP ${res.status}`);
    } catch {
      return fail(`Proxy not reachable at ${baseUrl}`);
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function collectStream(
  provider: StreamProvider,
  prompt: string,
): Promise<{ text: string; tokens: number }> {
  const chunks: string[] = [];
  let tokens = 0;

  for await (const chunk of provider.stream(prompt, {
    temperature: 0,
  })) {
    if (chunk.content) chunks.push(chunk.content);
    if (chunk.done && chunk.usage) {
      tokens = chunk.usage.completionTokens;
    }
  }

  return { text: chunks.join(""), tokens };
}

async function measureTTFC(
  provider: StreamProvider,
  prompt: string,
): Promise<number> {
  const start = Date.now();
  const controller = new AbortController();

  for await (const chunk of provider.stream(prompt, {
    temperature: 0,
    signal: controller.signal,
  })) {
    if (chunk.content && chunk.content.length > 0) {
      const ttfc = Date.now() - start;
      controller.abort();
      return ttfc;
    }
    if (chunk.done) break;
  }

  return Date.now() - start;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}


// ── Test runner ─────────────────────────────────────────────────────────────

interface ProviderTestResult {
  name: string;
  category: string;
  checks: CheckResult[];
}

async function testProvider(
  entry: ProviderConfigEntry,
  meta: ProviderMeta | undefined,
  dryRun: boolean,
): Promise<ProviderTestResult> {
  const category = meta?.category ?? "unknown";
  const name = entry.name ?? entry.type;
  const results: CheckResult[] = [];

  // Check 0: Provider-specific pre-check
  const specificResult = await checkProviderSpecific(entry);
  if (specificResult) {
    results.push(specificResult);
    printCheck(specificResult);
  }

  // Check 1: Config
  const configResult = checkConfig(entry, meta);
  results.push(configResult);
  printCheck(configResult);

  if (configResult.status === "fail") {
    results.push(skip("Skipped (config invalid)"));
    printCheck(results[results.length - 1]!);
    return { name, category, checks: results };
  }

  if (dryRun) {
    results.push(skip("Skipped (dry run)"));
    printCheck(results[results.length - 1]!);
    return { name, category, checks: results };
  }

  // Check 2: Connection
  const connResult = await checkConnection(entry);
  results.push(connResult);
  printCheck(connResult);

  if (connResult.status === "fail") {
    results.push(skip("Remaining checks skipped (connection failed)"));
    printCheck(results[results.length - 1]!);
    return { name, category, checks: results };
  }

  // Check 3: Models
  const modelResult = await checkModels(entry, meta);
  results.push(modelResult);
  printCheck(modelResult);

  // Check 4: Completion
  const completionResult = await checkCompletion(entry);
  results.push(completionResult);
  printCheck(completionResult);

  // Check 5: Streaming
  const streamResult = await checkStreaming(entry);
  results.push(streamResult);
  printCheck(streamResult);

  return { name, category, checks: results };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const config = readGlobalConfigWithDefaults();
  const entries = config.providers ?? [];

  console.log("");
  console.log(pc.bold("Provider Test Report"));
  console.log("─".repeat(40));

  const allResults: ProviderTestResult[] = [];
  let testedCount = 0;
  let totalChecks = 0;
  let passedChecks = 0;

  // Build test set
  let testEntries: ProviderConfigEntry[];

  if (args.provider) {
    const match = entries.find((e) => e.type === args.provider || e.name === args.provider);
    if (!match) {
      console.log(`\n${pc.red(ICONS.error)} Provider "${args.provider}" not found in config.`);
      console.log(pc.dim(`  Configured: ${entries.map((e) => e.type).join(", ") || "(none)"}`));
      process.exit(1);
    }
    testEntries = [match];
  } else {
    testEntries = entries;
  }

  if (testEntries.length === 0) {
    console.log(`\n${pc.yellow(ICONS.warning)} No providers configured.`);
    console.log(pc.dim("  Run: openpawl setup"));
    process.exit(0);
  }

  for (const entry of testEntries) {
    const meta = PROVIDER_CATALOG[entry.type as keyof typeof PROVIDER_CATALOG];
    const category = meta?.category ?? "unknown";
    const displayName = entry.name ?? meta?.name ?? entry.type;

    console.log(`\n${pc.bold(displayName)} ${pc.dim(`(${category})`)}`);

    const result = await testProvider(entry, meta, args.dryRun);
    allResults.push(result);
    testedCount++;

    for (const check of result.checks) {
      if (check.status !== "skip") totalChecks++;
      if (check.status === "pass") passedChecks++;
    }
  }

  // Show unconfigured providers (when --all)
  if (args.all) {
    const configuredTypes = new Set(entries.map((e) => e.type as string));
    const unconfigured = Object.entries(PROVIDER_CATALOG)
      .filter(([id]) => !configuredTypes.has(id))
      .filter(([, meta]) => meta.category !== "subscription"); // skip OAuth-only

    if (unconfigured.length > 0) {
      console.log(`\n${pc.dim("Not configured:")}`);
      for (const [id] of unconfigured.slice(0, 5)) {
        console.log(`  ${pc.dim(`${ICONS.error} ${id} \u2014 no config`)}`);
      }
      if (unconfigured.length > 5) {
        console.log(`  ${pc.dim(`... and ${unconfigured.length - 5} more`)}`);
      }
    }
  }

  // Summary
  console.log(`\n${"─".repeat(40)}`);
  const statusColor = passedChecks === totalChecks ? pc.green : passedChecks > 0 ? pc.yellow : pc.red;
  console.log(statusColor(
    `Results: ${testedCount}/${testEntries.length} providers tested | ${passedChecks}/${totalChecks} checks passed`,
  ));
  console.log("");

  process.exit(passedChecks === totalChecks ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${pc.red("Fatal error:")} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
