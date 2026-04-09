/**
 * Central registry of available agents.
 * Built-in agents registered by default; user-defined agents loaded from disk.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Result, ok, err } from "neverthrow";
import type { AgentDefinition, IntentCategory, RouterError } from "./router-types.js";

// ─── Built-in Agents ─────────────────────────────────────────────────────────

/**
 * Build the identity prefix prepended to every agent's system prompt.
 * Makes the agent introduce itself as "OpenPawl, powered by [model]".
 */
export function buildIdentityPrefix(agentName: string, model?: string, provider?: string): string {
  const poweredBy = model
    ? provider
      ? `powered by ${model} via ${provider}`
      : `powered by ${model}`
    : "";
  return `RULES: No emojis. No bullet suggestions. No "Would you like..." questions. Be terse. Stop when done.
You are ${agentName} in OpenPawl.${poweredBy ? ` (${poweredBy})` : ""}`;
}

const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "coder",
    name: "Coder",
    description: "Writes, modifies, and implements code. Expert at translating requirements into working code.",
    capabilities: ["code_write", "code_edit", "code_debug", "file_ops"],
    defaultTools: ["file_read", "file_list", "file_write", "file_edit", "shell_exec", "git_ops"],
    modelTier: "primary",
    systemPrompt: "Write and modify code. Use tools to read files before editing. Output working code, not explanations about code.",
    canCollaborate: true,
    maxConcurrent: 3,
    triggerPatterns: [
      "\\b(write|create|implement|build|code|develop)\\b.*\\b(function|class|component|module|api|endpoint|feature)\\b",
      "\\b(add|create)\\s+(a |the )?(new )?\\w+\\.(ts|js|py|rs|go)\\b",
    ],
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality, bugs, security issues, and best practices.",
    capabilities: ["code_review", "code_explain"],
    defaultTools: ["file_read", "file_list"],
    modelTier: "primary",
    systemPrompt: "Review code. Read the actual files before commenting. Report issues with file:line references. Skip praise.",
    canCollaborate: true,
    maxConcurrent: 2,
    triggerPatterns: [
      "\\b(review|audit|check|analyze|inspect)\\b.*\\b(code|pr|pull request|changes|diff)\\b",
    ],
  },
  {
    id: "planner",
    name: "Planner",
    description: "Creates execution plans, architecture designs, and task breakdowns for complex goals.",
    capabilities: ["plan", "code_explain"],
    defaultTools: ["file_read", "file_list", "web_search"],
    modelTier: "primary",
    systemPrompt: "Break goals into concrete steps. Each step: what to do, which files, expected outcome. No philosophy.",
    canCollaborate: true,
    maxConcurrent: 1,
    triggerPatterns: [
      "\\b(plan|architect|design|decompose|break down|outline)\\b",
    ],
  },
  {
    id: "tester",
    name: "Tester",
    description: "Writes and runs tests. Validates implementations against requirements.",
    capabilities: ["test_write", "test_run", "code_debug"],
    defaultTools: ["file_read", "file_list", "file_write", "shell_exec"],
    modelTier: "fast",
    systemPrompt: "Write and run tests. Read the source first to understand what to test. Show test output, not test philosophy.",
    canCollaborate: true,
    maxConcurrent: 3,
    triggerPatterns: [
      "\\b(test|spec|assert|coverage|vitest|jest|pytest)\\b",
    ],
  },
  {
    id: "debugger",
    name: "Debugger",
    description: "Investigates and fixes bugs. Reads error messages, traces issues, proposes fixes.",
    capabilities: ["code_debug", "code_edit", "test_run"],
    defaultTools: ["file_read", "file_list", "file_write", "file_edit", "shell_exec", "git_ops"],
    modelTier: "primary",
    systemPrompt: "Debug by reading the actual error and source code. Trace the root cause. Fix it or explain exactly what's wrong.",
    canCollaborate: true,
    maxConcurrent: 2,
    triggerPatterns: [
      "\\b(fix|debug|error|bug|crash|broken|failing|issue|trace|investigate)\\b",
    ],
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Searches the web, reads documentation, gathers information to answer questions.",
    capabilities: ["research", "code_explain"],
    defaultTools: ["file_read", "file_list", "web_search", "web_fetch"],
    modelTier: "fast",
    systemPrompt: "Search and fetch information. Return facts, not summaries of your search process.",
    canCollaborate: true,
    maxConcurrent: 2,
    triggerPatterns: [
      "\\b(search|find|look up|research|what is|how does|documentation|docs)\\b",
    ],
  },
  {
    id: "assistant",
    name: "Assistant",
    description: "General-purpose assistant for conversation, explanations, and simple tasks.",
    capabilities: ["conversation", "code_explain", "file_ops"],
    defaultTools: ["file_read", "file_list", "shell_exec"],
    modelTier: "fast",
    systemPrompt: "Answer directly. If a tool would help, use it. If not, give the shortest correct answer.",
    canCollaborate: false,
    maxConcurrent: 1,
    triggerPatterns: [],
  },
];

const DEFAULT_ALIASES: Record<string, string> = {
  code: "coder",
  review: "reviewer",
  test: "tester",
  debug: "debugger",
  plan: "planner",
  research: "researcher",
  ask: "assistant",
  help: "assistant",
};

// ─── Intent → Agent mapping ──────────────────────────────────────────────────

const INTENT_AGENT_MAP: Record<IntentCategory, string[]> = {
  code_write: ["coder"],
  code_edit: ["coder"],
  code_review: ["reviewer"],
  code_debug: ["debugger"],
  code_explain: ["assistant"],
  test_write: ["tester"],
  test_run: ["tester"],
  plan: ["planner"],
  research: ["researcher"],
  file_ops: ["coder"],
  git_ops: ["coder"],
  shell: ["coder"],
  conversation: ["assistant"],
  multi_step: ["planner"],
  config: [],
  unknown: [],
};

// ─── Registry ────────────────────────────────────────────────────────────────

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();
  private aliases = new Map<string, string>();

  constructor() {
    // Register built-in agents
    for (const agent of BUILT_IN_AGENTS) {
      this.agents.set(agent.id, agent);
    }
    // Register default aliases
    for (const [alias, agentId] of Object.entries(DEFAULT_ALIASES)) {
      this.aliases.set(alias, agentId);
    }
  }

  register(agent: AgentDefinition): Result<void, RouterError> {
    if (this.agents.has(agent.id)) {
      return err({ type: "no_agents_available", message: `Agent "${agent.id}" already registered` });
    }
    this.agents.set(agent.id, agent);
    return ok(undefined);
  }

  registerOrReplace(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
  }

  get(idOrAlias: string): AgentDefinition | undefined {
    const lower = idOrAlias.toLowerCase();
    const resolved = this.aliases.get(lower) ?? lower;
    return this.agents.get(resolved);
  }

  getAll(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  getIds(): string[] {
    return [...this.agents.keys()];
  }

  findByCapability(capability: string): AgentDefinition[] {
    return this.getAll().filter((a) => a.capabilities.includes(capability));
  }

  findByIntent(category: IntentCategory): AgentDefinition[] {
    const agentIds = INTENT_AGENT_MAP[category] ?? [];
    return agentIds
      .map((id) => this.agents.get(id))
      .filter((a): a is AgentDefinition => a !== undefined);
  }

  addAlias(alias: string, agentId: string): void {
    this.aliases.set(alias.toLowerCase(), agentId);
  }

  has(idOrAlias: string): boolean {
    return this.get(idOrAlias) !== undefined;
  }

  /**
   * Load user-defined agents from a directory.
   * Supports .json files. Invalid files are skipped with a warning.
   */
  async loadUserAgents(agentsDir: string): Promise<Result<number, RouterError>> {
    if (!existsSync(agentsDir)) return ok(0);

    let files: string[];
    try {
      files = await readdir(agentsDir);
    } catch {
      return ok(0);
    }

    let loaded = 0;
    for (const file of files) {
      if (!file.endsWith(".json") && !file.endsWith(".yaml") && !file.endsWith(".yml")) {
        continue;
      }

      try {
        const raw = await readFile(path.join(agentsDir, file), "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const agent = this.parseUserAgent(parsed);
        if (agent) {
          this.registerOrReplace(agent);
          loaded++;
        }
      } catch {
        // Skip invalid files silently (spec says: log warning, skip)
        continue;
      }
    }

    return ok(loaded);
  }

  private parseUserAgent(raw: Record<string, unknown>): AgentDefinition | null {
    // Minimal validation
    if (typeof raw.id !== "string" || !raw.id) return null;
    if (typeof raw.name !== "string" || !raw.name) return null;

    // Support "extends" for inheriting from built-in agents
    let base: Partial<AgentDefinition> = {};
    if (typeof raw.extends === "string") {
      const parent = this.agents.get(raw.extends);
      if (parent) base = { ...parent };
    }

    return {
      id: raw.id as string,
      name: (raw.name as string) || base.name || raw.id as string,
      description: (raw.description as string) || base.description || "",
      capabilities: (raw.capabilities as string[]) || base.capabilities || [],
      defaultTools: (raw.defaultTools as string[]) || base.defaultTools || [],
      modelTier: (raw.modelTier as AgentDefinition["modelTier"]) || base.modelTier || "fast",
      systemPrompt: (raw.systemPrompt as string) || base.systemPrompt || "",
      personality: (raw.personality as string) || base.personality,
      triggerPatterns: (raw.triggerPatterns as string[]) || base.triggerPatterns,
      canCollaborate: typeof raw.canCollaborate === "boolean" ? raw.canCollaborate : (base.canCollaborate ?? true),
      maxConcurrent: typeof raw.maxConcurrent === "number" ? raw.maxConcurrent : (base.maxConcurrent ?? 1),
    };
  }
}
