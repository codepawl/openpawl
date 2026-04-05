/**
 * Hot reload — watch agent directories for changes.
 */

import { watch } from "node:fs";
import { EventEmitter } from "node:events";
import type { AgentDirectory } from "./types.js";
import type { AgentYamlLoader } from "./yaml-loader.js";
import type { InheritanceResolver } from "./inheritance.js";
import type { AgentValidator } from "./validator.js";
import type { AgentRegistry } from "../../router/agent-registry.js";

export interface ReloadResult {
  added: string[];
  updated: string[];
  removed: string[];
  errors: Array<{ file: string; error: string }>;
}

export class AgentHotReloader extends EventEmitter {
  private watchers: Array<ReturnType<typeof watch>> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 500;

  constructor(
    private directories: AgentDirectory[],
    private loader: AgentYamlLoader,
    private resolver: InheritanceResolver,
    private validator: AgentValidator,
    private registry: AgentRegistry,
  ) {
    super();
  }

  start(): void {
    for (const dir of this.directories) {
      try {
        const watcher = watch(dir.path, { recursive: false }, () => {
          this.scheduleReload();
        });
        this.watchers.push(watcher);
      } catch {
        // Directory doesn't exist or can't be watched — skip
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  async reloadAll(): Promise<ReloadResult> {
    const result: ReloadResult = { added: [], updated: [], removed: [], errors: [] };

    const loadResult = await this.loader.loadAll(this.directories);
    if (loadResult.isErr()) return result;

    const { agents, errors } = loadResult.value;
    result.errors = errors;

    const resolved = this.resolver.resolveAll(agents);
    if (resolved.isErr()) return result;

    const currentIds = new Set(this.registry.getIds());

    // Added/updated agents
    for (const [id, agent] of resolved.value) {
      const def = {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        capabilities: agent.capabilities,
        defaultTools: agent.defaultTools,
        modelTier: agent.modelTier,
        systemPrompt: agent.systemPrompt,
        canCollaborate: agent.canCollaborate,
        maxConcurrent: agent.maxConcurrent,
        triggerPatterns: agent.triggerPatterns,
        destructive: false,
        requiresNetwork: false,
      };

      if (currentIds.has(id)) {
        this.registry.registerOrReplace(def);
        result.updated.push(id);
        this.emit("agent:updated", id);
      } else {
        this.registry.registerOrReplace(def);
        result.added.push(id);
        this.emit("agent:added", id);
      }
    }

    this.emit("reload:complete", result);
    return result;
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.reloadAll();
    }, this.debounceMs);
    if (this.debounceTimer.unref) this.debounceTimer.unref();
  }
}
