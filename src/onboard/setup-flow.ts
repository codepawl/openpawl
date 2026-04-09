import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectProviders, type DetectedProvider } from "../providers/detect.js";
import { validateApiKey } from "../providers/validate.js";
import { fetchModelsForProvider } from "../providers/model-fetcher.js";
import { getCachedModels, setCachedModels } from "../providers/model-cache.js";
import { getProviderMeta } from "../providers/provider-catalog.js";
import { getProviderRegistry } from "../providers/provider-registry.js";
import { maskCredential } from "../credentials/masking.js";
import { CredentialStore } from "../credentials/credential-store.js";
import {
  writeGlobalConfig,
  readGlobalConfig,
  type OpenPawlGlobalConfig,
  type ProviderConfigEntry,
} from "../core/global-config.js";

export interface SetupOptions {
  prefill?: OpenPawlGlobalConfig;
}

export function handleCancel<T>(value: T): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value;
}

function formatDetection(detected: DetectedProvider[]): void {
  p.log.step(pc.bold("Detecting providers..."));
  for (const d of detected) {
    if (d.available) {
      const detail = d.source === "env" ? `${d.envKey} found` : d.models ? `${d.models.length} models` : "detected";
      p.log.success(`${d.type} (${detail})`);
    } else {
      p.log.info(pc.dim(`${d.type} — not found`));
    }
  }
}

function buildProviderOptions(
  detected: DetectedProvider[],
  currentProvider?: string,
): Array<{ value: string; label: string; hint?: string }> {
  const options: Array<{ value: string; label: string; hint?: string }> = [];
  const added = new Set<string>();

  for (const d of detected.filter((p) => p.available)) {
    const meta = getProviderMeta(d.type);
    if (!meta || added.has(d.type)) continue;
    added.add(d.type);
    const hint = d.type === currentProvider ? "current" : "detected";
    options.push({ value: d.type, label: meta.menuLabel || meta.name, hint });
  }

  for (const def of getProviderRegistry().getAll()) {
    if (added.has(def.id)) continue;
    const meta = getProviderMeta(def.id);
    if (!meta || meta.group) continue;
    added.add(def.id);
    const hint = def.id === currentProvider ? "current" : undefined;
    options.push({ value: def.id, label: meta.menuLabel || meta.name, hint });
  }

  return options;
}

async function resolveModels(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<string[]> {
  const cached = await getCachedModels(providerId);
  if (cached && cached.length > 0) return cached;

  try {
    const result = await fetchModelsForProvider(providerId, apiKey, baseUrl);
    // result.models may be string[] (in tests) or FetchedModel[] (real API)
    const modelIds = result.models.map((m: string | { id: string }) =>
      typeof m === "string" ? m : m.id,
    );
    if (modelIds.length > 0) {
      await setCachedModels(providerId, modelIds);
      return modelIds;
    }
  } catch {
    // fall through to catalog
  }

  const meta = getProviderMeta(providerId);
  return meta?.models.map((m) => (typeof m === "string" ? m : m.id)) ?? [];
}

function getBaseUrl(providerId: string): string {
  const meta = getProviderMeta(providerId);
  return meta?.baseURL ?? "https://api.openai.com/v1";
}

export async function runSetup(options?: SetupOptions): Promise<void> {
  const prefill = options?.prefill;
  const isResetup = Boolean(prefill);

  p.intro(pc.bold(pc.cyan(isResetup ? "OpenPawl — Reconfigure" : "Welcome to OpenPawl — your AI team, one prompt away.")));

  // Step 1: Detect providers
  const detected = await detectProviders();
  formatDetection(detected);

  // Step 2: Select provider
  const providerOptions = buildProviderOptions(detected, prefill?.activeProvider);
  const initialValue = prefill?.activeProvider ?? providerOptions.find((o) => o.hint === "detected")?.value;

  const selectedProvider = handleCancel(
    await p.select({
      message: "Select a provider",
      options: providerOptions,
      initialValue,
    }),
  ) as string;

  // Step 3: API key (skip for local providers)
  const meta = getProviderMeta(selectedProvider);
  const needsKey = meta?.authMethod !== "local";
  let apiKey = "";
  let baseUrl = getBaseUrl(selectedProvider);

  if (selectedProvider === "ollama") {
    baseUrl = "http://localhost:11434";
  }

  if (needsKey) {
    const envDetected = detected.find((d) => d.type === selectedProvider && d.source === "env");
    if (envDetected?.envKey && process.env[envDetected.envKey]) {
      const envVal = process.env[envDetected.envKey]!;
      p.log.info(`Using ${envDetected.envKey} from environment (${maskCredential(envVal)})`);
      apiKey = envVal;
    } else {
      apiKey = handleCancel(
        await p.password({
          message: `API key for ${meta?.name ?? selectedProvider}`,
          validate: (v) => (v.length < 5 ? "Key too short" : undefined),
        }),
      ) as string;
    }

    // Validate key
    const spin = p.spinner();
    spin.start("Verifying API key...");
    const validResult = await validateApiKey(selectedProvider, apiKey, baseUrl);
    if (validResult.isErr()) {
      spin.stop(pc.red(`Validation failed: ${validResult.error.message}`));
      apiKey = handleCancel(
        await p.password({
          message: `Try again — API key for ${meta?.name ?? selectedProvider}`,
        }),
      ) as string;
      const retry = await validateApiKey(selectedProvider, apiKey, baseUrl);
      if (retry.isErr()) {
        p.cancel(`Could not validate key: ${retry.error.message}`);
        process.exit(1);
      }
      spin.stop(pc.green(`Connected (${retry.value.latencyMs}ms)`));
    } else {
      spin.stop(pc.green(`Connected (${validResult.value.latencyMs}ms)`));
    }

    // Store key securely
    const store = new CredentialStore();
    const initResult = await store.initialize();
    if (initResult.isOk()) {
      await store.setCredential(selectedProvider, "apiKey", apiKey);
    }
  }

  // Step 4: Select model
  const spin2 = p.spinner();
  spin2.start("Fetching available models...");
  const models = await resolveModels(selectedProvider, apiKey, baseUrl);
  spin2.stop(`${models.length} models available`);

  if (models.length === 0) {
    p.cancel("No models found for this provider. Check your provider setup.");
    process.exit(1);
  }

  const modelOptions = models.map((m) => ({
    value: m,
    label: m,
    hint: m === prefill?.activeModel ? "current" : undefined,
  }));

  const selectedModel = handleCancel(
    await p.select({
      message: "Select a model",
      options: modelOptions,
      initialValue: prefill?.activeModel ?? models[0],
    }),
  ) as string;

  // Step 5: Verify connection
  const spin3 = p.spinner();
  spin3.start("Verifying connection...");
  const healthResult = await validateApiKey(selectedProvider, apiKey, baseUrl);
  const latency = healthResult.isOk() ? `${healthResult.value.latencyMs}ms` : "ok";
  spin3.stop(pc.green(`Connected to ${meta?.name ?? selectedProvider} (${latency})`));

  // Step 6: Build and write config
  const existingConfig = readGlobalConfig();
  const providerEntry: ProviderConfigEntry = {
    type: selectedProvider as ProviderConfigEntry["type"],
    hasCredential: needsKey,
    model: selectedModel,
    baseURL: baseUrl !== getBaseUrl(selectedProvider) ? baseUrl : undefined,
  };

  const existingProviders = existingConfig?.providers?.filter((p) => p.type !== selectedProvider) ?? [];

  const newConfig: OpenPawlGlobalConfig = {
    ...(existingConfig ?? { version: 1, dashboardPort: 9001, debugMode: false }),
    activeProvider: selectedProvider,
    activeModel: selectedModel,
    model: selectedModel,
    providers: [providerEntry, ...existingProviders],
  };

  const configPath = writeGlobalConfig(newConfig);

  // Step 7: Summary
  p.note(
    [
      `Provider:  ${meta?.name ?? selectedProvider}`,
      `Model:     ${selectedModel}`,
      `Config:    ${configPath}`,
    ].join("\n"),
    "Configuration saved",
  );

  p.outro(isResetup ? "Configuration updated!" : "You're all set! Run openpawl to start.");
}
