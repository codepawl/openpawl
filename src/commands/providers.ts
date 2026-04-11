import {
  select,
  password,
  text,
  confirm,
  note,
  spinner,
  cancel,
} from "@clack/prompts";
import {
  getProvidersByCategory,
  getGroupVariants,
  getProviderMeta,
  type ProviderMeta,
} from "../providers/provider-catalog.js";
import { getProviderRegistry } from "../providers/provider-registry.js";
import { searchableSelect, clampSelectOptions } from "../utils/searchable-select.js";
import {
  readGlobalConfigWithDefaults,
  writeGlobalConfig,
  type ProviderConfigEntry,
} from "../core/global-config.js";
import {
  getActiveProviderName,
  setActiveProvider,
  listProviders as getConfigProviders,
} from "../core/provider-config.js";
import { validateApiKeyFormat, maskApiKey } from "../core/errors.js";
import { handleCancel } from "../onboard/setup-flow.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";
import { logger } from "../core/logger.js";
import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { fetchModelsForProvider } from "../providers/model-fetcher.js";
import { getCachedModels, setCachedModels } from "../providers/model-cache.js";
import { detectProviders } from "../providers/detect.js";
import { DOT_SYMBOL } from "../tui/components/status-indicator.js";

export async function runProvidersCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    logger.plain("Usage: openpawl providers <subcommand>");
    logger.plain("");
    logger.plain("Subcommands:");
    logger.plain("  list     Show configured providers and status");
    logger.plain("  add      Add a new provider interactively");
    logger.plain("  remove   Remove a configured provider");
    logger.plain("  test     Test each provider in the chain");
    return;
  }

  if (sub === "list") {
    await listProviders();
    return;
  }

  if (sub === "add") {
    await addProvider(args.slice(1));
    return;
  }

  if (sub === "remove") {
    await removeProvider(args.slice(1));
    return;
  }

  if (sub === "test") {
    await testProviders();
    return;
  }

  logger.error(`Unknown providers subcommand: ${sub}`);
  logger.error("Run `openpawl providers --help` for usage.");
  process.exit(1);
}

export async function listProviders(): Promise<void> {
  const configEntries = getConfigProviders();
  const activeProvider = getActiveProviderName();

  // Detect env-var providers
  const detected = await detectProviders();
  const envProviders = detected
    .filter((d) => d.source === "env" && d.available)
    .map((d) => ({ type: d.type, envVar: d.envKey ?? "" }));

  logger.plain("");
  logger.plain(pc.bold("  Provider         Type             Model              Status"));
  logger.plain(pc.dim("  " + "─".repeat(70)));

  if (configEntries.length > 0) {
    for (const entry of configEntries) {
      const name = (entry.name ?? entry.type).padEnd(16);
      const type = entry.type.padEnd(16);
      const model = (entry.model ?? "(none)").padEnd(18);
      const isActive = entry.type === activeProvider;
      const hasKey = !!(entry.apiKey || entry.oauthToken || entry.githubToken || entry.copilotToken || entry.hasCredential);
      const noKeyNeeded = entry.type === "ollama" || entry.type === "lmstudio";

      let status: string;
      if (isActive) {
        status = pc.green(`${DOT_SYMBOL.filled} active`);
      } else if (hasKey || noKeyNeeded) {
        status = pc.dim(`${DOT_SYMBOL.empty} configured`);
      } else {
        status = pc.yellow(`${DOT_SYMBOL.empty} no API key`);
      }

      logger.plain(`  ${name} ${type} ${model} ${status}`);
    }
  }

  if (envProviders.length > 0) {
    for (const ep of envProviders) {
      // Skip if already in config
      if (configEntries.some((e) => e.type === ep.type)) continue;
      const name = ep.type.padEnd(16);
      const type = ep.type.padEnd(16);
      const model = "(none)".padEnd(18);
      const isActive = ep.type === activeProvider;
      const status = isActive
        ? pc.green(`${DOT_SYMBOL.filled} active (env)`)
        : pc.dim(`${DOT_SYMBOL.empty} from env`);
      logger.plain(`  ${name} ${type} ${model} ${status}`);
    }
  }

  if (configEntries.length === 0 && envProviders.length === 0) {
    logger.plain("");
    logger.plain(pc.yellow("  No providers configured."));
    logger.plain(pc.dim("  Run `openpawl setup` or set an API key env var (e.g. ANTHROPIC_API_KEY)."));
  }

  logger.plain("");
}

async function testProviders(): Promise<void> {
  const manager = await getGlobalProviderManager();
  const providers = manager.getProviders();

  if (providers.length === 0) {
    logger.plain(pc.yellow("No providers configured. Nothing to test."));
    logger.plain(pc.dim("Run `openpawl setup` or set an API key env var (e.g. ANTHROPIC_API_KEY)."));
    return;
  }

  logger.plain("Testing providers...\n");

  let healthy = 0;
  for (const provider of providers) {
    const start = Date.now();
    let ok = false;
    try {
      ok = await provider.healthCheck();
    } catch {
      ok = false;
    }
    const latency = Date.now() - start;

    if (ok) {
      healthy++;
      logger.plain(`  ${pc.green(ICONS.success)} ${pc.bold(provider.name)}  connected (${latency}ms)`);
    } else {
      logger.plain(`  ${pc.red(ICONS.error)} ${pc.bold(provider.name)}  unreachable`);
    }
  }

  logger.plain("");
  logger.plain(`${healthy}/${providers.length} provider(s) healthy.`);

  if (providers.length > 1) {
    logger.plain("");
    logger.plain("Fallback order:");
    providers.forEach((p, i) => {
      logger.plain(`  ${i + 1}. ${p.name}`);
    });
  }
}

// ── Remove provider ──────────────────────────────────────────────────────

async function removeProvider(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    logger.error("Usage: openpawl providers remove <provider-type>");
    logger.error("Example: openpawl providers remove ollama");
    process.exit(1);
  }

  const entries = getConfigProviders();
  const entry = entries.find((e) => e.type === name || e.name === name);
  if (!entry) {
    logger.error(`Provider "${name}" not found in config.`);
    logger.plain(pc.dim("  Run `openpawl providers list` to see configured providers."));
    process.exit(1);
  }

  const confirmed = await confirm({
    message: `Remove provider ${pc.bold(entry.name ?? entry.type)}?`,
    initialValue: false,
  });
  if (!confirmed || typeof confirmed === "symbol") {
    cancel("Cancelled.");
    return;
  }

  getProviderRegistry().removeConfig(entry.type);
  logger.plain(`${pc.green(ICONS.success)} Provider ${pc.bold(entry.name ?? entry.type)} removed.`);
}

// ── Add provider ─────────────────────────────────────────────────────────

export async function addProvider(args: string[]): Promise<void> {
  const directId = args[0];
  let selectedId: string;

  if (directId && getProviderRegistry().getDefinition(directId)) {
    selectedId = directId;
  } else {
    const categories = [
      { key: "subscription" as const, emoji: "\u{1F3AB}", label: "Subscription plans" },
      { key: "apikey" as const, emoji: "\u{1F511}", label: "API keys (pay per token)" },
      { key: "opencode" as const, emoji: "\u{1F7E2}", label: "OpenCode subscriptions" },
      { key: "cloud" as const, emoji: "\u2601\uFE0F", label: "Cloud credentials" },
      { key: "local" as const, emoji: "\u{1F3E0}", label: "Local (free, private)" },
    ];

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    for (const cat of categories) {
      const providers = getProvidersByCategory(cat.key);
      for (const [id, meta] of providers) {
        // Skip variants that are reachable via their group parent
        if (meta.group && meta.group !== id) continue;
        options.push({
          value: id,
          label: `${cat.emoji} ${id.padEnd(16)} ${meta.menuLabel}`,
          hint: meta.menuHint,
        });
      }
    }

    selectedId = handleCancel(
      await searchableSelect({ message: "How do you want to add a provider?", options, maxItems: 12 }),
    ) as string;
  }

  let meta = getProviderMeta(selectedId)!;

  // If the selected provider is a group parent, show sub-selection for variants
  if (meta.group && meta.group === selectedId) {
    const variants = getGroupVariants(selectedId);
    if (variants.length > 1) {
      const variantChoice = handleCancel(
        await select({
          message: `Which ${meta.name} variant?`,
          options: clampSelectOptions(variants.map(([id, m]) => ({ value: id, label: m.name, hint: m.menuHint }))),
        }),
      ) as string;
      selectedId = variantChoice;
      meta = getProviderMeta(selectedId)!;
    }
  }

  // Show warning if present
  if (meta.warning) {
    console.log(`\n${meta.warning}\n`);
    const accepted = handleCancel(
      await confirm({ message: "Do you understand and want to proceed?", initialValue: false }),
    ) as boolean;
    if (!accepted) {
      cancel("Cancelled.");
      return;
    }
  }

  const entry: ProviderConfigEntry = { type: selectedId as ProviderConfigEntry["type"] };

  // Auth-specific prompts
  if (meta.authMethod === "apikey") {
    await promptApiKey(entry, selectedId, meta);
  } else if (meta.authMethod === "local") {
    await promptLocalProvider(entry, selectedId, meta);
  } else if (meta.authMethod === "device-oauth" && selectedId === "copilot") {
    await promptCopilotAuth(entry);
  } else if (meta.authMethod === "credentials" && selectedId === "bedrock") {
    await promptBedrockAuth(entry);
  } else if (meta.authMethod === "credentials" && selectedId === "vertex") {
    await promptVertexAuth(entry);
  } else if (meta.authMethod === "oauth") {
    await promptChatGPTAuth(entry);
  }

  // Model selection — try live fetch, fall back to catalog
  let modelOptions: Array<{ value: string; label: string; hint?: string }> = [];
  let sourceHint = "";

  if (entry.apiKey || entry.githubToken ||
      selectedId === "ollama" || selectedId === "lmstudio") {
    const cached = await getCachedModels(selectedId);
    if (cached && cached.length > 0) {
      modelOptions = cached.map((id) => ({ value: id, label: id }));
      sourceHint = "cached";
    } else {
      const s = spinner();
      s.start("Fetching available models...");
      const result = await fetchModelsForProvider(
        selectedId,
        entry.apiKey ?? entry.githubToken ?? "",
        entry.baseURL,
      );
      if (result.source === "live" && result.models.length > 0) {
        const ids = result.models.map((m) => m.id);
        modelOptions = result.models.slice(0, 50).map((m) => ({
          value: m.id,
          label: m.name !== m.id ? `${m.id}  ${pc.dim(m.name)}` : m.id,
        }));
        sourceHint = "live";
        setCachedModels(selectedId, ids).catch(() => {});
        s.stop(`${pc.green(`${result.models.length} models available`)}`);
      } else {
        if (result.error) logger.debug(`Model fetch failed: ${result.error}`);
        s.stop(pc.dim("Using default model list"));
      }
    }
  }

  // Fall back to catalog
  if (modelOptions.length === 0 && meta.models.length > 0) {
    modelOptions = meta.models.map((m) => ({ value: m.id, label: m.label, hint: m.hint }));
  }

  if (modelOptions.length > 0) {
    const selectOptions = clampSelectOptions([
      ...modelOptions,
      { value: "__custom__", label: "Other (enter manually)" },
    ]);
    const modelChoice = handleCancel(
      await searchableSelect({
        message: `Choose a model:${sourceHint ? ` ${pc.dim(`(${sourceHint})`)}` : ""}`,
        options: selectOptions,
        maxItems: 12,
      }),
    ) as string;
    if (modelChoice === "__custom__") {
      const custom = handleCancel(
        await text({
          message: "Enter model name:",
          placeholder: meta.models[0]?.id ?? "model-name",
        }),
      ) as string;
      entry.model = custom.trim();
    } else {
      entry.model = modelChoice;
    }
  }

  // Save to config
  const config = readGlobalConfigWithDefaults();
  const providers = config.providers ?? [];
  const filtered = providers.filter((p) => p.type !== entry.type);
  filtered.push(entry);
  config.providers = filtered;
  writeGlobalConfig(config);

  // Set as active provider if it's the first/only one or no active provider set
  const currentActive = getActiveProviderName();
  if (!currentActive || filtered.length === 1) {
    setActiveProvider(entry.type);
    if (entry.model) {
      const { setActiveModel } = await import("../core/provider-config.js");
      setActiveModel(entry.model);
    }
  }

  logger.plain(`\n${pc.green(ICONS.success)} Provider ${pc.bold(meta.name)} added successfully.`);
  if (entry.model) logger.plain(`  Model: ${entry.model}`);
  logger.plain(pc.dim("  Run: openpawl providers test"));
}

async function promptApiKey(
  entry: ProviderConfigEntry,
  providerId: string,
  meta: ProviderMeta,
): Promise<void> {
  // Check env vars first
  for (const envKey of meta.envKeys) {
    const envVal = process.env[envKey];
    if (envVal) {
      logger.plain(`  Found ${pc.bold(envKey)} in environment: ${pc.dim(maskApiKey(envVal))}`);
      const useEnv = handleCancel(
        await confirm({ message: `Use ${envKey} from environment?`, initialValue: true }),
      ) as boolean;
      if (useEnv) {
        entry.apiKey = envVal;
        return;
      }
    }
  }

  // Show setup instructions
  const { PROVIDER_SETUP_HINTS, API_KEY_PREFIXES } = await import("../core/errors.js");
  const hints = PROVIDER_SETUP_HINTS[providerId];
  if (hints) {
    logger.plain("");
    for (const step of hints) {
      logger.plain(`  ${pc.dim(step)}`);
    }
    const prefix = API_KEY_PREFIXES[providerId];
    if (prefix) logger.plain(`  Starts with: ${pc.dim(prefix)}`);
  } else {
    if (meta.keyUrl) {
      logger.plain(`  Get your API key at: ${pc.green(meta.keyUrl)}`);
    }
    if (meta.keyPrefix) {
      logger.plain(pc.dim(`  Key starts with: ${meta.keyPrefix}`));
    }
  }

  const key = handleCancel(
    await password({ message: `Enter your ${meta.name} API key:` }),
  ) as string;

  const trimmed = key.trim();
  const validation = validateApiKeyFormat(providerId, trimmed);
  if (!validation.valid) {
    logger.plain(pc.yellow(`  Warning: ${validation.hint}`));
    const proceed = handleCancel(
      await confirm({ message: "Use this key anyway?", initialValue: false }),
    ) as boolean;
    if (!proceed) {
      cancel("Cancelled.");
      process.exit(0);
    }
  }

  entry.apiKey = trimmed;
}

async function promptLocalProvider(
  entry: ProviderConfigEntry,
  providerId: string,
  meta: ProviderMeta,
): Promise<void> {
  const defaultUrl = meta.baseURL ?? (providerId === "ollama" ? "http://localhost:11434/v1" : "http://localhost:1234/v1");

  const url = handleCancel(
    await text({
      message: `Enter ${meta.name} URL:`,
      placeholder: defaultUrl,
      defaultValue: defaultUrl,
    }),
  ) as string;

  entry.baseURL = url.trim();

  // Probe endpoint
  const s = spinner();
  s.start(`Checking ${meta.name}...`);
  try {
    const probeUrl = providerId === "ollama"
      ? entry.baseURL.replace(/\/v1$/, "/api/tags")
      : `${entry.baseURL}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(probeUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      s.stop(`${meta.name} is running`);
    } else {
      s.stop(`${meta.name} responded with ${res.status}`);
      logger.plain(pc.yellow("  Provider may not be ready. You can still save and try later."));
    }
  } catch {
    s.stop(`${meta.name} not reachable`);
    logger.plain(pc.yellow(`  Could not connect to ${entry.baseURL}`));
    logger.plain(pc.dim(`  Make sure ${meta.name} is running and try again.`));
  }
}

async function promptCopilotAuth(entry: ProviderConfigEntry): Promise<void> {
  entry.authMethod = "device-oauth";

  // Check GITHUB_TOKEN
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) {
    logger.plain(`  Found ${pc.bold("GITHUB_TOKEN")} in environment: ${pc.dim(maskApiKey(ghToken))}`);
    const useEnv = handleCancel(
      await confirm({ message: "Use GITHUB_TOKEN from environment?", initialValue: true }),
    ) as boolean;
    if (useEnv) {
      entry.githubToken = ghToken;
      return;
    }
  }

  // Run device flow
  const { runCopilotDeviceFlow, pollCopilotDeviceToken } = await import(
    "../providers/copilot-provider.js"
  );

  const s = spinner();
  s.start("Starting GitHub device flow...");

  let deviceData: { device_code: string; user_code: string; verification_uri: string; interval?: number };
  try {
    const raw = await runCopilotDeviceFlow();
    deviceData = JSON.parse(raw);
    s.stop("Device flow started");
  } catch (err) {
    s.stop("Failed to start device flow");
    logger.plain(pc.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  note(
    `Open: ${pc.cyan(deviceData.verification_uri)}\nEnter code: ${pc.bold(deviceData.user_code)}`,
    "GitHub Device Auth",
  );

  const pollS = spinner();
  pollS.start("Waiting for authorization...");

  const interval = (deviceData.interval ?? 5) * 1000;
  const maxAttempts = 60;
  let token: string | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      token = await pollCopilotDeviceToken(deviceData.device_code);
      if (token) break;
    } catch {
      // Keep polling
    }
  }

  if (token) {
    pollS.stop("Authorized");
    entry.githubToken = token;
  } else {
    pollS.stop("Authorization timed out");
    logger.plain(pc.yellow("  Device flow timed out. Please try again."));
  }
}

async function promptChatGPTAuth(entry: ProviderConfigEntry): Promise<void> {
  const { runChatGPTOAuthFlow } = await import("../providers/chatgpt-auth.js");

  const spin = spinner();
  spin.start("Opening browser for ChatGPT login...");

  const result = await runChatGPTOAuthFlow();

  if (result.isErr()) {
    spin.stop(pc.red(`ChatGPT login failed: ${result.error.message}`));
    return;
  }

  const tokens = result.value;
  entry.oauthToken = tokens.accessToken;
  entry.refreshToken = tokens.refreshToken;
  entry.tokenExpiry = Date.now() + tokens.expiresIn * 1000;
  entry.authMethod = "oauth";

  // Also store in credential store
  try {
    const { CredentialStore } = await import("../credentials/credential-store.js");
    const store = new CredentialStore();
    await store.initialize();
    await store.setCredential("chatgpt", "oauthToken", tokens.accessToken);
    await store.setCredential("chatgpt", "refreshToken", tokens.refreshToken);
  } catch { /* best-effort */ }

  spin.stop(pc.green("ChatGPT login successful!"));
}

async function promptBedrockAuth(entry: ProviderConfigEntry): Promise<void> {
  entry.authMethod = "credentials";

  // Check env vars
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION;

  if (accessKey && secretKey) {
    logger.plain(`  Found AWS credentials in environment`);
    logger.plain(`    AWS_ACCESS_KEY_ID: ${pc.dim(maskApiKey(accessKey))}`);
    if (region) logger.plain(`    Region: ${pc.dim(region)}`);

    const useEnv = handleCancel(
      await confirm({ message: "Use AWS credentials from environment?", initialValue: true }),
    ) as boolean;
    if (useEnv) {
      entry.accessKeyId = accessKey;
      entry.secretAccessKey = secretKey;
      if (region) entry.region = region;
      return;
    }
  }

  const ak = handleCancel(
    await text({ message: "AWS Access Key ID:", placeholder: "AKIA..." }),
  ) as string;
  entry.accessKeyId = ak.trim();

  const sk = handleCancel(
    await password({ message: "AWS Secret Access Key:" }),
  ) as string;
  entry.secretAccessKey = sk.trim();

  const reg = handleCancel(
    await text({ message: "AWS Region:", placeholder: "us-east-1", defaultValue: "us-east-1" }),
  ) as string;
  entry.region = reg.trim();
}

async function promptVertexAuth(entry: ProviderConfigEntry): Promise<void> {
  entry.authMethod = "credentials";

  // Check env
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (saPath) {
    logger.plain(`  Found GOOGLE_APPLICATION_CREDENTIALS: ${pc.dim(saPath)}`);
    const useEnv = handleCancel(
      await confirm({ message: "Use existing service account credentials?", initialValue: true }),
    ) as boolean;
    if (useEnv) {
      entry.serviceAccountPath = saPath;
      const projectId = handleCancel(
        await text({ message: "GCP Project ID:", placeholder: "my-project-id" }),
      ) as string;
      entry.projectId = projectId.trim();
      const region = handleCancel(
        await text({ message: "Region:", placeholder: "us-central1", defaultValue: "us-central1" }),
      ) as string;
      entry.region = region.trim();
      return;
    }
  }

  const sa = handleCancel(
    await text({
      message: "Path to service account JSON:",
      placeholder: "/path/to/service-account.json",
    }),
  ) as string;
  entry.serviceAccountPath = sa.trim();

  const projectId = handleCancel(
    await text({ message: "GCP Project ID:", placeholder: "my-project-id" }),
  ) as string;
  entry.projectId = projectId.trim();

  const region = handleCancel(
    await text({ message: "Region:", placeholder: "us-central1", defaultValue: "us-central1" }),
  ) as string;
  entry.region = region.trim();
}
