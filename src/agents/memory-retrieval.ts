/**
 * Memory Retrieval Node - Retrieves relevant memories from LanceDB before Sprint Planning.
 */

import type { GraphState } from "../core/graph-state.js";
import type { VectorMemory } from "../core/knowledge-base.js";
import type { HttpEmbeddingFunction } from "../core/knowledge-base.js";
import type { SuccessPatternStore } from "../memory/success/store.js";
import type { GlobalMemoryManager } from "../memory/global/store.js";
import { retrieveSuccessPatterns } from "../memory/success/retriever.js";
import { logger, isDebugMode } from "../core/logger.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

export class MemoryRetrievalNode {
  private readonly vectorMemory: VectorMemory;
  private readonly maxRetroActions: number;
  private readonly maxProjectMemories: number;
  private readonly successStore: SuccessPatternStore | null;
  private readonly embedder: HttpEmbeddingFunction | null;
  private readonly globalManager: GlobalMemoryManager | null;

  constructor(
    vectorMemory: VectorMemory,
    maxRetroActions = 5,
    maxProjectMemories = 2,
    successStore: SuccessPatternStore | null = null,
    embedder: HttpEmbeddingFunction | null = null,
    globalManager: GlobalMemoryManager | null = null,
  ) {
    this.vectorMemory = vectorMemory;
    this.maxRetroActions = maxRetroActions;
    this.maxProjectMemories = maxProjectMemories;
    this.successStore = successStore;
    this.embedder = embedder;
    this.globalManager = globalManager;
    log(`MemoryRetrievalNode initialized (maxActions: ${maxRetroActions}, maxProjects: ${maxProjectMemories}, successStore: ${!!successStore}, globalManager: ${!!globalManager})`);
  }

  async retrieveMemories(state: GraphState): Promise<Partial<GraphState>> {
    const userGoal = state.user_goal;

    if (!userGoal) {
      return {
        retrieved_memories: "",
        preferences_context: "",
        messages: [],
        last_action: "No user goal provided, skipping memory retrieval",
        __node__: "memory_retrieval",
      };
    }

    log(`Retrieving memories for goal: ${userGoal.slice(0, 50)}...`);

    try {
      const [retroActions, projectMemories] = await Promise.all([
        this.vectorMemory.retrieveRelevantRetroActions(userGoal, this.maxRetroActions),
        this.vectorMemory.retrieveRelevantMemories(userGoal, this.maxProjectMemories),
      ]);

      // Retrieve success patterns if store is available
      const successPatterns = this.successStore && this.embedder
        ? await retrieveSuccessPatterns(this.successStore, this.embedder, userGoal)
        : [];

      const memoriesLines: string[] = [];

      if (retroActions.length > 0) {
        memoriesLines.push("## User Preferences from Past Projects:");
        for (const action of retroActions) {
          const priority = (action.metadata.priority_score as number) ?? 1;
          const category = (action.metadata.category as string) ?? "general";
          const priorityTag = priority >= 10 ? " [HIGH PRIORITY]" : "";
          memoriesLines.push(`- ${action.text} (category: ${category})${priorityTag}`);
        }
      }

      if (projectMemories.length > 0) {
        memoriesLines.push("\n## Past Project Context:");
        for (const memory of projectMemories) {
          memoriesLines.push(`- ${memory}`);
        }
      }

      if (successPatterns.length > 0) {
        memoriesLines.push("\n## Proven Approaches from Past Successes:");
        for (const pattern of successPatterns) {
          const conf = Math.round(pattern.confidence * 100);
          memoriesLines.push(`- Task: "${pattern.taskDescription.slice(0, 60)}" | Approach: ${pattern.approach.slice(0, 100)} | Confidence: ${conf}%`);
        }
      }

      // Query global memory if available
      let globalPatterns: typeof successPatterns = [];
      let globalLessons: Array<{ text: string }> = [];
      if (this.globalManager && this.embedder) {
        try {
          const globalStore = this.globalManager.getPatternStore();
          const queryVector = (await this.embedder.generate([userGoal]))[0] ?? [];
          if (globalStore && queryVector.length > 0) {
            globalPatterns = await globalStore.search(queryVector, 3);
          }
          const rawLessons = await this.globalManager.searchLessons(queryVector, 3);
          globalLessons = rawLessons.map((l) => ({ text: l.text }));
        } catch (err) {
          log(`Global memory query failed: ${err}`);
        }

        // Deduplicate: remove global patterns already in session results
        const sessionIds = new Set(successPatterns.map((p) => p.id));
        globalPatterns = globalPatterns.filter((p) => !sessionIds.has(p.id));

        // Cap total: 3 patterns + 3 lessons
        const allLessons = globalLessons.map((l) => l.text).slice(0, 3);

        if (globalPatterns.length > 0 || globalLessons.length > 0) {
          memoriesLines.push("\n## Global Knowledge (Cross-Session):");
          for (const pattern of globalPatterns.slice(0, 3 - successPatterns.length)) {
            const conf = Math.round(pattern.confidence * 100);
            memoriesLines.push(`pattern=${pattern.taskDescription.slice(0, 40)} approach=${pattern.approach.slice(0, 70)} conf=${conf}%`);
          }
          for (const lesson of allLessons) {
            memoriesLines.push(`lesson=${lesson.slice(0, 80)}`);
          }
        }
      }

      const preferencesContext = memoriesLines.join("\n");
      const globalCount = globalPatterns.length + globalLessons.length;
      const summaryMsg = `Retrieved ${retroActions.length} preferences, ${projectMemories.length} project memories, ${successPatterns.length} success patterns${globalCount > 0 ? `, and ${globalCount} global memories` : ""}`;

      if (retroActions.length > 0 || projectMemories.length > 0 || successPatterns.length > 0 || globalCount > 0) {
        log(`${summaryMsg}. Context length: ${preferencesContext.length} chars`);
      }

      return {
        retrieved_memories: preferencesContext,
        preferences_context: preferencesContext,
        memory_context: {
          failureLessons: retroActions.map((a) => a.text),
          successPatterns,
          relevanceScores: [],
        },
        global_memory_context: {
          globalPatterns,
          globalLessons: globalLessons.map((l) => l.text),
        },
        messages: [summaryMsg],
        last_action: "Memory retrieval complete",
        __node__: "memory_retrieval",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Memory retrieval failed: ${errMsg}`);
      return {
        retrieved_memories: "",
        preferences_context: "",
        messages: ["Memory retrieval failed, proceeding without past context"],
        last_action: "Memory retrieval failed",
        __node__: "memory_retrieval",
      };
    }
  }
}

export function createMemoryRetrievalNode(
  vectorMemory: VectorMemory,
  maxRetroActions = 5,
  maxProjectMemories = 2,
  successStore: SuccessPatternStore | null = null,
  embedder: HttpEmbeddingFunction | null = null,
  globalManager: GlobalMemoryManager | null = null,
): (state: GraphState) => Promise<Partial<GraphState>> {
  const node = new MemoryRetrievalNode(vectorMemory, maxRetroActions, maxProjectMemories, successStore, embedder, globalManager);
  return (state: GraphState) => node.retrieveMemories(state);
}
