/**
 * Setup Step 1: Provider configuration — select providers, API keys, fallback chain.
 */

import {
    cancel,
    confirm,
    select,
    spinner,
    text,
    password,
} from "@clack/prompts";
import pc from "picocolors";
import type { ProviderConfigEntry } from "../../core/global-config.js";
import { randomPhrase } from "../../utils/spinner-phrases.js";
import { PROVIDER_CATALOG } from "../../providers/provider-catalog.js";
import { searchableSelect, clampSelectOptions } from "../../utils/searchable-select.js";
import { fetchModelsForProvider } from "../../providers/model-fetcher.js";
import { getCachedModels, setCachedModels } from "../../providers/model-cache.js";
import { logger } from "../../core/logger.js";
import { ICONS } from "../../tui/constants/icons.js";


export interface WizardState {
    providerEntries: ProviderConfigEntry[];
    projectName: string;
    selectedModel: string;
    goal: string;
    roster: import("../../core/team-templates.js").RosterEntry[];
    templateId: string;
    teamMode?: string;
    anthropicApiKey?: string;
}

import { handleCancel } from "../../onboard/setup-flow.js";
export { handleCancel };

type ProviderType = ProviderConfigEntry["type"];

const PROVIDER_CHOICES: Array<{ value: string; label: string; hint?: string }> = [
    // Subscription plans (first — users already pay for these)
    { value: "chatgpt", label: "ChatGPT Plus/Pro", hint: "Use your ChatGPT Plus/Pro subscription" },
    { value: "copilot", label: "GitHub Copilot", hint: "Use your Copilot subscription — no API key needed" },
    // API keys
    { value: "anthropic", label: "Anthropic (Claude)", hint: "Claude models" },
    { value: "openai", label: "OpenAI (GPT)", hint: "Great quality" },
    { value: "gemini", label: "Google Gemini", hint: "API key or subscription (OAuth)" },
    { value: "grok", label: "xAI Grok", hint: "2M token context · live web search" },
    { value: "mistral", label: "Mistral AI", hint: "EU data residency" },
    { value: "deepseek", label: "DeepSeek", hint: "Best value — frontier quality at low cost" },
    { value: "groq", label: "Groq", hint: "Fastest inference" },
    { value: "cerebras", label: "Cerebras", hint: "Ultra-fast inference" },
    { value: "together", label: "Together AI", hint: "100+ open models, $100 free" },
    { value: "fireworks", label: "Fireworks AI", hint: "Fast open model serving" },
    { value: "openrouter", label: "OpenRouter", hint: "200+ models, one key" },
    { value: "perplexity", label: "Perplexity", hint: "Answers backed by live web search" },
    { value: "moonshot", label: "Moonshot AI (Kimi)", hint: "Kimi K2.5" },
    { value: "zai", label: "Z.AI (GLM / Zhipu)", hint: "GLM-5" },
    { value: "minimax", label: "MiniMax", hint: "1M context" },
    { value: "cohere", label: "Cohere", hint: "Best for document Q&A and search" },
    // OpenCode
    { value: "opencode", label: "OpenCode", hint: "Zen (frontier) + Go (open, $10/mo)" },
    // Cloud
    { value: "bedrock", label: "AWS Bedrock", hint: "IAM credentials" },
    { value: "vertex", label: "Google Vertex AI", hint: "Service account" },
    { value: "azure", label: "Azure OpenAI", hint: "API key + endpoint" },
    // Local
    { value: "ollama", label: "Ollama", hint: "Free \u00b7 Runs locally \u00b7 No key" },
    { value: "lmstudio", label: "LM Studio", hint: "Free \u00b7 Runs locally \u00b7 No key" },
    { value: "custom", label: "Custom", hint: "Any OpenAI-compatible API" },
];

/** Get default model for a provider from the catalog, with fallbacks for legacy types */
function getDefaultModel(providerType: string): string {
    const meta = PROVIDER_CATALOG[providerType];
    return meta?.models[0]?.id ?? "";
}

async function testOllamaConnection(baseURL: string): Promise<boolean> {
    const s = spinner();
    s.start(randomPhrase("gateway"));
    try {
        const url = baseURL.replace(/\/+$/, "") + "/api/tags";
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            s.stop(pc.green("Ollama is reachable!"));
            return true;
        }
        s.stop(pc.yellow(`Ollama responded with status ${res.status}`));
        return false;
    } catch {
        s.stop(pc.yellow(`Could not reach Ollama at ${baseURL}`));
        return false;
    }
}

async function testProviderConnection(entry: ProviderConfigEntry): Promise<boolean> {
    // Skip providers that are already tested or can't be meaningfully tested
    if (entry.type === "ollama" || entry.type === "lmstudio") return true;
    const meta = PROVIDER_CATALOG[entry.type];
    if (meta?.authMethod === "credentials" || meta?.authMethod === "local") return true;
    if (!entry.apiKey) return true;
    // Providers without a /models listing endpoint — healthCheck uses models.list() which would fail
    if (entry.type === "opencode-zen" || entry.type === "opencode-go") return true;

    const { providerFromConfig } = await import("../../providers/provider-factory.js");
    const provider = await providerFromConfig(entry);
    if (!provider) return true;

    const s = spinner();
    s.start(randomPhrase("network"));
    try {
        const ok = await Promise.race([
            provider.healthCheck(),
            new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
        if (ok) {
            s.stop(pc.green("Connection verified!"));
            return true;
        }
        s.stop(pc.yellow("Could not verify connection."));
        return false;
    } catch {
        s.stop(pc.yellow("Could not verify connection."));
        return false;
    }
}

async function promptProviderEntry(): Promise<ProviderConfigEntry> {
    const providerType = handleCancel(
        await searchableSelect({
            message: "Which AI provider will power your team?",
            options: PROVIDER_CHOICES,
            maxItems: 12,
        }),
    ) as string;

    const entry: ProviderConfigEntry = { type: providerType as ProviderType };

    if (providerType === "ollama") {
        console.log([
            "",
            `  ${pc.bold("Ollama runs AI models locally on your machine.")}`,
            `  It's completely free — no API key needed.`,
            "",
            `  Requirements:`,
            `  \u00b7 Ollama installed: ${pc.green("https://ollama.ai/download")}`,
            `  \u00b7 At least one model pulled: ${pc.dim("ollama pull llama3")}`,
            "",
        ].join("\n"));

        const baseURL = handleCancel(
            await text({
                message: "Ollama base URL:",
                initialValue: "http://localhost:11434",
                placeholder: "http://localhost:11434",
                validate: (v) =>
                    (v ?? "").trim().length > 0 ? undefined : "URL cannot be empty",
            }),
        ) as string;
        entry.baseURL = baseURL.trim();

        const reachable = await testOllamaConnection(entry.baseURL);
        if (!reachable) {
            console.log([
                "",
                `  ${pc.yellow(ICONS.warning)} Ollama is not running at ${entry.baseURL}`,
                "",
                `  To install Ollama:`,
                `    1. Download from: ${pc.green("https://ollama.ai/download")}`,
                `    2. Install and open it`,
                `    3. Pull a model: ${pc.dim("ollama pull llama3")}`,
                `    4. Come back and run: ${pc.dim("openpawl setup")}`,
                "",
            ].join("\n"));

            const proceed = handleCancel(
                await confirm({
                    message: "Continue setup without Ollama running?",
                    initialValue: true,
                }),
            ) as boolean;
            if (!proceed) {
                cancel("Cancelled.");
                process.exit(0);
            }
        }
    } else if (providerType === "opencode") {
        const variant = handleCancel(
            await select({
                message: "Which OpenCode plan?",
                options: clampSelectOptions([
                    { value: "opencode-zen", label: "OpenCode Zen", hint: "Curated frontier models (Claude, GPT, Gemini)" },
                    { value: "opencode-go", label: "OpenCode Go", hint: "Curated open models ($10/mo)" },
                ]),
            }),
        ) as string;
        entry.type = variant as ProviderType;

        const { PROVIDER_SETUP_HINTS, API_KEY_PREFIXES, validateApiKeyFormat } = await import("../../core/errors.js");
        const providerLabel = variant === "opencode-zen" ? "OpenCode Zen" : "OpenCode Go";
        const hints = PROVIDER_SETUP_HINTS[variant];
        const prefix = API_KEY_PREFIXES[variant];

        if (hints) {
            console.log("");
            for (const step of hints) {
                console.log(`  ${pc.dim(step)}`);
            }
        }
        if (prefix) {
            console.log(`  Starts with: ${pc.dim(prefix)}`);
        }
        console.log(`  ${pc.dim("Your key is stored locally in ~/.openpawl/config.json")}`);

        const apiKey = handleCancel(
            await password({ message: `${providerLabel} API key:` }),
        ) as string;

        if (!apiKey?.trim()) {
            const proceed = handleCancel(
                await confirm({ message: "No key entered — some features won't work. Continue anyway?", initialValue: false }),
            ) as boolean;
            if (!proceed) { cancel("Cancelled."); process.exit(0); }
        } else {
            const validation = validateApiKeyFormat(variant, apiKey.trim());
            if (validation.valid) {
                console.log(`  ${pc.green(ICONS.success)} Key format looks good`);
            } else {
                console.log(`  ${pc.yellow(ICONS.warning)} ${validation.hint}`);
                const proceed = handleCancel(
                    await confirm({ message: "This key format doesn't look right. Use it anyway?", initialValue: true }),
                ) as boolean;
                if (!proceed) { cancel("Cancelled."); process.exit(0); }
            }
            entry.apiKey = apiKey.trim();
        }
    } else if (providerType === "gemini") {
        const authMethod = handleCancel(
            await select({
                message: "How do you want to authenticate?",
                options: clampSelectOptions([
                    { value: "apikey", label: "API key", hint: "Recommended \u00b7 free tier available" },
                    { value: "oauth", label: "Gemini subscription (OAuth)", hint: "\u26a0\ufe0f Account ban risk" },
                ]),
            }),
        ) as string;

        if (authMethod === "oauth") {
            entry.type = "gemini-oauth" as ProviderType;

            const meta = PROVIDER_CATALOG["gemini-oauth"];
            if (meta?.warning) {
                console.log(`\n${meta.warning}\n`);
                const accepted = handleCancel(
                    await confirm({ message: "Do you understand and want to proceed?", initialValue: false }),
                ) as boolean;
                if (!accepted) { cancel("Cancelled."); process.exit(0); }
            }

            console.log(`  ${pc.yellow(ICONS.warning)} OAuth flow not yet implemented in CLI.`);
            console.log(`  ${pc.dim("Workaround: use API key instead.")}`);
        } else {
            // Standard API key flow
            const { PROVIDER_SETUP_HINTS, API_KEY_PREFIXES, validateApiKeyFormat } = await import("../../core/errors.js");
            const hints = PROVIDER_SETUP_HINTS.gemini;
            const prefix = API_KEY_PREFIXES.gemini;
            const catalogMeta = PROVIDER_CATALOG["gemini"];
            console.log("");
            if (hints) {
                for (const step of hints) {
                    console.log(`  ${pc.dim(step)}`);
                }
            } else if (catalogMeta?.keyUrl) {
                console.log(`  Get your key at: ${pc.green(catalogMeta.keyUrl)}`);
            }
            if (prefix) console.log(`  Starts with: ${pc.dim(prefix)}`);
            console.log(`  ${pc.dim("Your key is stored locally in ~/.openpawl/config.json")}`);

            const apiKey = handleCancel(
                await password({ message: "Google Gemini API key:" }),
            ) as string;

            if (!apiKey?.trim()) {
                const proceed = handleCancel(
                    await confirm({ message: "No key entered — some features won't work. Continue anyway?", initialValue: false }),
                ) as boolean;
                if (!proceed) { cancel("Cancelled."); process.exit(0); }
            } else {
                const validation = validateApiKeyFormat("gemini", apiKey.trim());
                if (validation.valid) {
                    console.log(`  ${pc.green(ICONS.success)} Key format looks good`);
                } else {
                    console.log(`  ${pc.yellow(ICONS.warning)} ${validation.hint}`);
                    const proceed = handleCancel(
                        await confirm({ message: "This key format doesn't look right. Use it anyway?", initialValue: true }),
                    ) as boolean;
                    if (!proceed) { cancel("Cancelled."); process.exit(0); }
                }
                entry.apiKey = apiKey.trim();
            }
        }
    } else if (providerType === "custom") {
        const name = handleCancel(
            await text({
                message: "Provider name (for display):",
                placeholder: "my-provider",
                validate: (v) =>
                    (v ?? "").trim().length > 0 ? undefined : "Name cannot be empty",
            }),
        ) as string;
        entry.name = name.trim();

        const baseURL = handleCancel(
            await text({
                message: "Base URL (OpenAI-compatible endpoint):",
                placeholder: "https://api.example.com/v1",
                validate: (v) =>
                    (v ?? "").trim().length > 0 ? undefined : "URL cannot be empty",
            }),
        ) as string;
        entry.baseURL = baseURL.trim();

        const apiKey = handleCancel(
            await password({
                message: "API key (press Enter to skip if not required):",
            }),
        ) as string;
        if (apiKey?.trim()) entry.apiKey = apiKey.trim();
    } else {
        // All other providers that need an API key
        const { PROVIDER_URLS, API_KEY_PREFIXES, PROVIDER_SETUP_HINTS, validateApiKeyFormat } = await import("../../core/errors.js");
        const urls = PROVIDER_URLS[providerType];
        const providerLabel = PROVIDER_CHOICES.find((c) => c.value === providerType)!.label;
        const prefix = API_KEY_PREFIXES[providerType];
        const hints = PROVIDER_SETUP_HINTS[providerType];

        // Show setup instructions
        if (hints) {
            console.log("");
            for (const step of hints) {
                console.log(`  ${pc.dim(step)}`);
            }
        } else if (urls?.keyUrl) {
            console.log(`\n  Get your key at: ${pc.green(urls.keyUrl)}`);
        }
        if (prefix) {
            console.log(`  Starts with: ${pc.dim(prefix)}`);
        }
        console.log(`  ${pc.dim("Your key is stored locally in ~/.openpawl/config.json")}`);

        const apiKey = handleCancel(
            await password({
                message: `${providerLabel} API key:`,
            }),
        ) as string;

        if (!apiKey?.trim()) {
            const proceed = handleCancel(
                await confirm({
                    message: "No key entered — some features won't work. Continue anyway?",
                    initialValue: false,
                }),
            ) as boolean;
            if (!proceed) {
                cancel("Cancelled.");
                process.exit(0);
            }
        } else {
            // Validate format
            const validation = validateApiKeyFormat(providerType, apiKey.trim());
            if (validation.valid) {
                console.log(`  ${pc.green(ICONS.success)} Key format looks good`);
            } else {
                console.log(`  ${pc.yellow(ICONS.warning)} ${validation.hint}`);
                const proceed = handleCancel(
                    await confirm({
                        message: "This key format doesn't look right. Use it anyway?",
                        initialValue: true,
                    }),
                ) as boolean;
                if (!proceed) {
                    cancel("Cancelled.");
                    process.exit(0);
                }
            }
            entry.apiKey = apiKey.trim();
        }
    }

    // Model selection — try live fetch, fall back to catalog
    const catalogMeta = PROVIDER_CATALOG[entry.type];
    const catalogModels = catalogMeta?.models ?? [];

    let modelOptions: Array<{ value: string; label: string; hint?: string }> = [];
    let sourceHint = "";

    // Providers with no model listing endpoint — skip fetch, use catalog directly
    const CATALOG_ONLY_PROVIDERS = new Set(["opencode-zen", "opencode-go", "bedrock", "vertex", "azure"]);

    if (!CATALOG_ONLY_PROVIDERS.has(entry.type) && (entry.apiKey || entry.type === "ollama" || entry.type === "lmstudio")) {
        // Try cache first, then live fetch
        const cached = await getCachedModels(entry.type);
        if (cached && cached.length > 0) {
            modelOptions = cached.map((id) => ({ value: id, label: id }));
            sourceHint = "cached";
        } else {
            const s = spinner();
            s.start("Fetching available models...");
            const result = await fetchModelsForProvider(
                entry.type,
                entry.apiKey ?? "",
                entry.baseURL,
            );
            if (result.source === "live" && result.models.length > 0) {
                const ids = result.models.map((m) => m.id);
                modelOptions = result.models.slice(0, 50).map((m) => ({
                    value: m.id,
                    label: m.name !== m.id ? `${m.id}  ${pc.dim(m.name)}` : m.id,
                }));
                sourceHint = "live";
                // Cache for next time (fire-and-forget)
                setCachedModels(entry.type, ids).catch(() => {});
                s.stop(`${pc.green(`${result.models.length} models available`)}`);
            } else {
                s.stop(pc.yellow("Could not fetch models \u2014 using defaults"));
                if (result.error) logger.warn(`Model fetch: ${result.error}. Run ${pc.bold("openpawl model refresh")} later to update.`);
            }
        }
    }

    // Fall back to catalog if live/cached fetch didn't produce results
    if (modelOptions.length === 0 && catalogModels.length > 0) {
        modelOptions = catalogModels.map((m) => ({ value: m.id, label: m.label, hint: m.hint }));
    }

    if (modelOptions.length > 0) {
        const selectOptions = clampSelectOptions([
            ...modelOptions,
            { value: "__custom__", label: "Enter model name manually" },
        ]);
        const modelChoice = handleCancel(
            await searchableSelect({
                message: `Which model should your team use?${sourceHint ? ` ${pc.dim(`(${sourceHint})`)}` : ""}`,
                options: selectOptions,
                maxItems: 12,
            }),
        ) as string;
        if (modelChoice === "__custom__") {
            const custom = handleCancel(
                await text({ message: "Enter model name:", placeholder: catalogModels[0]?.id ?? "model-name" }),
            ) as string;
            if (custom.trim()) entry.model = custom.trim();
        } else {
            entry.model = modelChoice;
        }
    }

    // Health check — verify the API key works before continuing
    const connected = await testProviderConnection(entry);
    if (!connected) {
        const action = handleCancel(
            await select({
                message: "What would you like to do?",
                options: clampSelectOptions([
                    { value: "continue", label: "Continue anyway", hint: "You can fix the key later" },
                    { value: "reenter", label: "Re-enter API key", hint: "Try a different key" },
                ]),
            }),
        ) as string;
        if (action === "reenter") {
            return promptProviderEntry();
        }
    }

    return entry;
}

function formatProviderLabel(entry: ProviderConfigEntry, index: number): string {
    const name = entry.name || entry.type;
    const model = entry.model || getDefaultModel(entry.type) || "default";
    const keyStatus = entry.apiKey ? "key set" : entry.type === "ollama" ? "local" : "no key";
    return `Provider ${index + 1}: ${pc.cyan(name)} (model: ${model}, ${keyStatus})`;
}

export async function stepProvider(state: WizardState): Promise<void> {
    state.providerEntries = [];

    // First provider is required
    const entry = await promptProviderEntry();
    state.providerEntries.push(entry);
    console.log(`  ${pc.green("+")} ${formatProviderLabel(entry, 0)}`);

    // Fallback providers loop
    while (true) {
        const addMore = handleCancel(
            await confirm({
                message: "Add a fallback provider? (used if the first one fails)",
                initialValue: false,
            }),
        ) as boolean;

        if (!addMore) break;

        const fallback = await promptProviderEntry();
        state.providerEntries.push(fallback);
        console.log(`  ${pc.green("+")} ${formatProviderLabel(fallback, state.providerEntries.length - 1)}`);
    }
}
