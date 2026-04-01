/**
 * Session finalization — audit export, CONTEXT.md handoff, custom composition rules.
 * Extracted from work-runner.ts. All functions are non-blocking (never crash the session).
 */

import path from "node:path";
import os from "node:os";
import { buildAuditTrail, renderAuditMarkdown } from "../audit/index.js";
import { VectorMemory } from "../core/knowledge-base.js";
import { CONFIG } from "../core/config.js";
import { AgentRegistryStore } from "../agents/registry/index.js";
import type { BotDefinition } from "../core/bot-definitions.js";
import type { AgentInclusionRule } from "../agents/composition/rules.js";

/** Auto-export audit trail to markdown after run completes. Never blocks. */
export async function autoExportAudit(
  sessionId: string,
  runIndex: number,
  finalState: Record<string, unknown>,
  startTime: number,
  team: BotDefinition[],
): Promise<void> {
  try {
    const audit = await buildAuditTrail(sessionId, runIndex, finalState, startTime, Date.now(), team);
    const md = renderAuditMarkdown(audit);
    const { writeFile, mkdir } = await import("node:fs/promises");
    const sessionDir = path.join(os.homedir(), ".teamclaw", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "audit.md"), md, "utf-8");
  } catch {
    // Non-critical — auto-export failure should never affect the session
  }
}

/** Auto-generate CONTEXT.md handoff after session completes. Never blocks or throws. */
export async function autoGenerateContext(
  sessionId: string,
  goal: string,
  finalState: Record<string, unknown>,
  workspacePath: string,
): Promise<void> {
  try {
    const { readGlobalConfigWithDefaults: readCfg } = await import("../core/global-config.js");
    const cfg = readCfg();
    if (cfg.handoff?.autoGenerate === false) return;

    const { buildHandoffData, renderContextMarkdown } = await import("../handoff/index.js");

    // Retrieve active decisions (best-effort)
    let activeDecisions: import("../journal/types.js").Decision[] = [];
    try {
      const { DecisionStore } = await import("../journal/store.js");
      const { GlobalMemoryManager } = await import("../memory/global/store.js");
      const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
      await vm.init();
      const embedder = vm.getEmbedder();
      if (embedder) {
        const gmm = new GlobalMemoryManager();
        await gmm.init(embedder);
        const db = gmm.getDb();
        if (db) {
          const store = new DecisionStore();
          await store.init(db);
          const recent = await store.getRecentDecisions(30);
          activeDecisions = recent.filter((d) => d.status === "active");
        }
      }
    } catch {
      // Non-critical
    }

    const taskQueue = (finalState.task_queue ?? []) as Array<Record<string, unknown>>;
    const nextSprintBacklog = (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>;
    const promotedThisRun = (finalState.promoted_this_run ?? []) as string[];
    const agentProfiles = (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>;
    const rfcDocument = (finalState.rfc_document as string) ?? null;

    const data = buildHandoffData({
      sessionId,
      projectPath: workspacePath,
      goal,
      taskQueue,
      nextSprintBacklog,
      promotedThisRun,
      agentProfiles,
      activeDecisions: activeDecisions as never[],
      rfcDocument,
    });

    const markdown = renderContextMarkdown(data);

    const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");

    // Write to workspace
    const outputPath = path.resolve(workspacePath, cfg.handoff?.outputPath ?? "./CONTEXT.md");
    await wf(outputPath, markdown, "utf-8");

    // Timestamped copy in session dir
    const sessionDir = path.join(os.homedir(), ".teamclaw", "sessions", sessionId);
    await mkd(sessionDir, { recursive: true });
    await wf(path.join(sessionDir, "CONTEXT.md"), markdown, "utf-8");

    // Git commit if configured (existing code — uses execSync for git operations)
    if (cfg.handoff?.gitCommit) {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`git add "${outputPath}"`, { stdio: "ignore", cwd: workspacePath });
        execSync(`git commit -m "docs: auto-generate CONTEXT.md handoff"`, { stdio: "ignore", cwd: workspacePath });
      } catch {
        // Never fail loudly
      }
    }
  } catch {
    // Auto-generation must never block the session
  }
}

/** Build composition inclusion rules from registered custom agents. */
export function buildCustomCompositionRules(): AgentInclusionRule[] {
  try {
    const store = new AgentRegistryStore();
    const defs = store.loadAllSync();
    return defs
      .filter((d) => d.compositionRules)
      .map((d) => ({
        role: d.role,
        required: d.compositionRules?.required ?? false,
        keywords: d.compositionRules?.includeKeywords ?? [],
        negativeKeywords: d.compositionRules?.excludeKeywords ?? [],
        description: d.description,
      }));
  } catch {
    return [];
  }
}
