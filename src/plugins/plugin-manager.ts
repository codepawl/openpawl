/**
 * Plugin lifecycle management.
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Result, ok, err } from "neverthrow";
import { HookSystem } from "./hook-system.js";
import type { PluginDefinition, PluginContext, PluginError, PluginLogger } from "./types.js";

export class PluginManager {
  private hookSystem = new HookSystem();
  private loaded = new Map<string, PluginDefinition>();

  async loadFromDirectory(dir: string): Promise<void> {
    if (!existsSync(dir)) return;

    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        await this.loadPlugin(fullPath);
      }
    } catch {
      // Directory unreadable — skip
    }
  }

  async loadPlugin(pluginPath: string): Promise<Result<void, PluginError>> {
    try {
      const mod = await import(pluginPath);
      const definition = (mod.default ?? mod) as PluginDefinition;

      if (!definition.name || !definition.version) {
        return err({ type: "invalid_plugin", name: pluginPath, cause: "Missing name or version" });
      }

      const context = this.createContext(definition.name);
      this.hookSystem.register(definition, context);
      this.loaded.set(definition.name, definition);

      return ok(undefined);
    } catch (e) {
      return err({ type: "load_failed", path: pluginPath, cause: String(e) });
    }
  }

  unloadPlugin(name: string): void {
    this.hookSystem.unregister(name);
    this.loaded.delete(name);
  }

  getLoaded(): PluginDefinition[] {
    return [...this.loaded.values()];
  }

  getHookSystem(): HookSystem {
    return this.hookSystem;
  }

  async executeHook(hookName: string, ...args: unknown[]): Promise<void> {
    await this.hookSystem.executeHook(hookName as keyof import("./types.js").PluginHooks, ...args);
  }

  private createContext(pluginName: string): PluginContext {
    const logger: PluginLogger = {
      info: (msg) => console.log(`[plugin:${pluginName}] ${msg}`),
      warn: (msg) => console.warn(`[plugin:${pluginName}] ${msg}`),
      error: (msg) => console.error(`[plugin:${pluginName}] ${msg}`),
    };

    return {
      config: {},
      logger,
      emit: () => {},
    };
  }
}
