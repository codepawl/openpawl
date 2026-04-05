/**
 * Event-based hook infrastructure for plugins.
 */

import type { PluginDefinition, PluginContext, PluginHooks } from "./types.js";

const HOOK_TIMEOUT_MS = 5000;

interface RegisteredPlugin {
  definition: PluginDefinition;
  context: PluginContext;
}

export class HookSystem {
  private plugins: RegisteredPlugin[] = [];

  register(definition: PluginDefinition, context: PluginContext): void {
    this.plugins.push({ definition, context });
    // Sort alphabetically for deterministic execution order
    this.plugins.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  unregister(name: string): void {
    this.plugins = this.plugins.filter((p) => p.definition.name !== name);
  }

  async executeHook(hookName: keyof PluginHooks, ...args: unknown[]): Promise<void> {
    for (const plugin of this.plugins) {
      const hook = plugin.definition.hooks?.[hookName];
      if (!hook) continue;

      try {
        await Promise.race([
          (hook as (...args: unknown[]) => Promise<unknown>)(plugin.context, ...args),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Hook timeout: ${hookName} in ${plugin.definition.name}`)), HOOK_TIMEOUT_MS),
          ),
        ]);
      } catch (e) {
        // Log but don't crash — plugin errors never block OpenPawl
        plugin.context.logger.error(`Hook ${hookName} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Execute onPromptReceived hooks as a pipeline (each can transform the prompt).
   */
  async executePromptPipeline(prompt: string): Promise<string> {
    let result = prompt;
    for (const plugin of this.plugins) {
      const hook = plugin.definition.hooks?.onPromptReceived;
      if (!hook) continue;

      try {
        const transformed = await Promise.race([
          hook(plugin.context, result),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), HOOK_TIMEOUT_MS),
          ),
        ]);
        if (typeof transformed === "string") result = transformed;
      } catch {
        // Skip this plugin's transformation on error
      }
    }
    return result;
  }

  getRegistered(): PluginDefinition[] {
    return this.plugins.map((p) => p.definition);
  }
}
