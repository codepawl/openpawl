/**
 * Converts custom AgentDefinitions into WorkerBot instances for graph integration.
 */

import { ROLE_TEMPLATES } from "../../core/bot-definitions.js";
import type { BotDefinition } from "../../core/bot-definitions.js";
import { WorkerBot } from "../worker-bot.js";
import { UniversalOpenClawAdapter } from "../../adapters/worker-adapter.js";
import { CONFIG } from "../../core/config.js";
import { registerConfidenceFlags } from "../../graph/confidence/types.js";
import type { ValidatedAgentDef } from "./validator.js";

/** Create a BotDefinition for a custom agent. */
function createBotDefinition(def: ValidatedAgentDef): BotDefinition {
  const roleId = def.role.replace(/-/g, "_");
  return {
    id: `custom-${def.role}`,
    name: def.displayName,
    role_id: roleId,
    traits: {
      focus: def.description,
      skills: def.taskTypes,
      task_types: def.taskTypes,
      custom_agent: true,
    },
    worker_url: null,
  };
}

/** Register a custom agent into ROLE_TEMPLATES so the coordinator recognizes it. */
function registerRoleTemplate(def: ValidatedAgentDef): void {
  const roleId = def.role.replace(/-/g, "_");
  if (!(roleId in ROLE_TEMPLATES)) {
    ROLE_TEMPLATES[roleId] = {
      id: roleId,
      name: def.displayName,
      skills: def.taskTypes,
      task_types: def.taskTypes,
      default_traits: { focus: def.description },
    };
  }
}

/**
 * Create WorkerBot instances from custom agent definitions.
 * Returns bot map and BotDefinition array for graph integration.
 */
export function createCustomWorkerBots(
  agents: ValidatedAgentDef[],
  workspacePath: string,
): { bots: Record<string, WorkerBot>; botDefs: BotDefinition[] } {
  const bots: Record<string, WorkerBot> = {};
  const botDefs: BotDefinition[] = [];

  for (const def of agents) {
    registerRoleTemplate(def);

    // Register custom confidence flags
    if (def.confidenceConfig?.flags?.length) {
      registerConfidenceFlags(def.confidenceConfig.flags);
    }

    const botDef = createBotDefinition(def);
    botDefs.push(botDef);

    const adapter = new UniversalOpenClawAdapter({
      workerUrl: CONFIG.openclawWorkerUrl,
      authToken: CONFIG.openclawToken,
      workspacePath,
      botId: botDef.id,
      systemPromptOverride: def.systemPrompt,
    });

    // Wrap adapter with hooks if defined
    if (def.hooks) {
      wrapAdapterWithHooks(adapter, def);
    }

    bots[botDef.id] = new WorkerBot(botDef, adapter);
  }

  return { bots, botDefs };
}

/** Wrap an adapter's executeTask to invoke lifecycle hooks. */
function wrapAdapterWithHooks(
  adapter: UniversalOpenClawAdapter,
  def: ValidatedAgentDef,
): void {
  const originalExecuteTask = adapter.executeTask.bind(adapter);

  adapter.executeTask = async (task, options) => {
    const context = {
      sessionId: "",
      taskId: task.task_id,
      runIndex: 0,
      proxyUrl: "",
      config: {},
    };

    let processedTask = task;
    if (def.hooks?.beforeTask) {
      const transformed = await def.hooks.beforeTask(
        task as unknown as Record<string, unknown>,
        context,
      );
      processedTask = transformed as typeof task;
    }

    try {
      const result = await originalExecuteTask(processedTask, options);

      if (def.hooks?.afterTask) {
        const transformed = await def.hooks.afterTask(
          result as unknown as Record<string, unknown>,
          context,
        );
        return transformed as typeof result;
      }

      return result;
    } catch (err) {
      if (def.hooks?.onError) {
        await def.hooks.onError(err instanceof Error ? err : new Error(String(err)), context);
      }
      throw err;
    }
  };
}
