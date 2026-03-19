/**
 * Setup Step 1: Provider configuration — select providers, API keys, fallback chain.
 */

import {
    confirm,
    isCancel,
    cancel,
    select,
    spinner,
    text,
    password,
} from "@clack/prompts";
import pc from "picocolors";
import type { ProviderConfigEntry } from "../../core/global-config.js";
import { randomPhrase } from "../../utils/spinner-phrases.js";
import { PROVIDER_CATALOG } from "../../providers/provider-catalog.js";

export interface WizardState {
    providerEntries: ProviderConfigEntry[];
    workspaceDir: string;
    projectName: string;
    selectedModel: string;
    goal: string;
    roster: import("../../core/team-templates.js").RosterEntry[];
    templateId: string;
    teamMode?: string;
    anthropicApiKey?: string;
}

export function handleCancel<T>(v: T): T {
    if (isCancel(v)) {
        cancel("Setup cancelled.");
        process.exit(0);
    }
    return v;
}

type ProviderType = ProviderConfigEntry["type"];

const PROVIDER_CHOICES: Array<{ value: string; label: string; hint?: string }> = [
    // Subscription plans (first — users already pay for these)
    { value: "chatgpt", label: "ChatGPT Plus/Pro", hint: "OAuth [officially supported by OpenAI]" },
    { value: "copilot", label: "GitHub Copilot", hint: "Device OAuth [officially supported]" },
    { value: "anthropic-sub", label: "Claude Pro/Max", hint: "setup-token [ToS gray area]" },
    // API keys
    { value: "anthropic", label: "Anthropic (Claude)", hint: "Recommended \u00b7 Best quality" },
    { value: "openai", label: "OpenAI (GPT)", hint: "Great quality" },
    { value: "gemini", label: "Google Gemini", hint: "API key [free tier available]" },
    { value: "grok", label: "xAI Grok", hint: "2M context, real-time X" },
    { value: "mistral", label: "Mistral AI", hint: "EU data residency" },
    { value: "deepseek", label: "DeepSeek", hint: "Cheapest frontier" },
    { value: "groq", label: "Groq", hint: "Fastest inference" },
    { value: "cerebras", label: "Cerebras", hint: "Extreme throughput" },
    { value: "together", label: "Together AI", hint: "100+ open models, $100 free" },
    { value: "fireworks", label: "Fireworks AI", hint: "Fast open model serving" },
    { value: "openrouter", label: "OpenRouter", hint: "200+ models, one key" },
    { value: "perplexity", label: "Perplexity", hint: "Web-grounded search" },
    { value: "moonshot", label: "Moonshot AI (Kimi)", hint: "Kimi K2.5" },
    { value: "zai", label: "Z.AI (GLM / Zhipu)", hint: "GLM-5" },
    { value: "minimax", label: "MiniMax", hint: "1M context" },
    { value: "cohere", label: "Cohere", hint: "RAG specialist" },
    // OpenCode
    { value: "opencode-zen", label: "OpenCode Zen", hint: "Curated frontier models" },
    { value: "opencode-go", label: "OpenCode Go", hint: "Curated open models ($10/mo)" },
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

async function promptProviderEntry(): Promise<ProviderConfigEntry> {
    const providerType = handleCancel(
        await select({
            message: "Choose your AI provider\n  " + pc.dim("Tip: Not sure? Pick Anthropic \u2014 it's what TeamClaw was built and tested with."),
            options: PROVIDER_CHOICES,
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
            `  \u00b7 Ollama installed: ${pc.cyan("https://ollama.ai/download")}`,
            `  \u00b7 At least one model pulled: ${pc.dim("ollama pull llama3.1")}`,
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
                `  ${pc.yellow("\u26a0")} Ollama is not running at ${entry.baseURL}`,
                "",
                `  To install Ollama:`,
                `    1. Download from: ${pc.cyan("https://ollama.ai/download")}`,
                `    2. Install and open it`,
                `    3. Pull a model: ${pc.dim("ollama pull llama3.1")}`,
                `    4. Come back and run: ${pc.dim("teamclaw setup")}`,
                "",
            ].join("\n"));

            const proceed = handleCancel(
                await confirm({
                    message: "Continue setup without Ollama running?",
                    initialValue: true,
                }),
            ) as boolean;
            if (!proceed) {
                cancel("Setup cancelled.");
                process.exit(0);
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
        // Anthropic, OpenAI, OpenRouter, DeepSeek, Groq — all need an API key
        const { PROVIDER_URLS, API_KEY_PREFIXES, validateApiKeyFormat, maskApiKey } = await import("../../core/errors.js");
        const urls = PROVIDER_URLS[providerType];
        const providerLabel = PROVIDER_CHOICES.find((c) => c.value === providerType)!.label;
        const prefix = API_KEY_PREFIXES[providerType];

        // Show guidance
        const guidance = [
            urls?.keyUrl ? `Get your key at: ${pc.cyan(urls.keyUrl)}` : "",
            prefix ? `Starts with: ${pc.dim(prefix)}` : "",
            `Your key is stored locally in ~/.teamclaw/config.json`,
        ].filter(Boolean).join("\n  ");
        console.log(`  ${guidance}`);

        const apiKey = handleCancel(
            await password({
                message: `${providerLabel} API key:`,
            }),
        ) as string;

        if (!apiKey?.trim()) {
            const proceed = handleCancel(
                await confirm({
                    message: "No API key entered. Continue without one?",
                    initialValue: false,
                }),
            ) as boolean;
            if (!proceed) {
                cancel("Setup cancelled.");
                process.exit(0);
            }
        } else {
            // Validate format
            const validation = validateApiKeyFormat(providerType, apiKey.trim());
            if (validation.valid) {
                console.log(`  ${pc.green("\u2713")} Format looks correct  ${pc.dim(maskApiKey(apiKey.trim()))}`);
            } else {
                console.log(`  ${pc.yellow("\u26a0")} ${validation.hint}`);
                const proceed = handleCancel(
                    await confirm({
                        message: "Key format looks unusual. Use it anyway?",
                        initialValue: true,
                    }),
                ) as boolean;
                if (!proceed) {
                    cancel("Setup cancelled.");
                    process.exit(0);
                }
            }
            entry.apiKey = apiKey.trim();
        }
    }

    // Model override
    const defaultModel = getDefaultModel(providerType) || "";
    const modelInput = handleCancel(
        await text({
            message: `Model override (leave empty for default${defaultModel ? `: ${defaultModel}` : ""}):`,
            initialValue: "",
            placeholder: defaultModel || "default",
        }),
    ) as string;
    if (modelInput?.trim()) {
        entry.model = modelInput.trim();
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
                message: "Add another provider as fallback?",
                initialValue: false,
            }),
        ) as boolean;

        if (!addMore) break;

        const fallback = await promptProviderEntry();
        state.providerEntries.push(fallback);
        console.log(`  ${pc.green("+")} ${formatProviderLabel(fallback, state.providerEntries.length - 1)}`);
    }
}
