/**
 * Memory Retrieval Node - Retrieves relevant memories from LanceDB before Sprint Planning.
 */

import type { GraphState } from "../core/graph-state.js";
import type { VectorMemory } from "../core/knowledge-base.js";
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

  constructor(
    vectorMemory: VectorMemory,
    maxRetroActions = 5,
    maxProjectMemories = 2
  ) {
    this.vectorMemory = vectorMemory;
    this.maxRetroActions = maxRetroActions;
    this.maxProjectMemories = maxProjectMemories;
    log(`🧠 MemoryRetrievalNode initialized (maxActions: ${maxRetroActions}, maxProjects: ${maxProjectMemories})`);
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

    log(`🧠 Retrieving memories for goal: ${userGoal.slice(0, 50)}...`);

    try {
      const [retroActions, projectMemories] = await Promise.all([
        this.vectorMemory.retrieveRelevantRetroActions(userGoal, this.maxRetroActions),
        this.vectorMemory.retrieveRelevantMemories(userGoal, this.maxProjectMemories),
      ]);

      const memoriesLines: string[] = [];
      
      if (retroActions.length > 0) {
        memoriesLines.push("## 📋 User Preferences from Past Projects:");
        for (const action of retroActions) {
          const priority = (action.metadata.priority_score as number) ?? 1;
          const category = (action.metadata.category as string) ?? "general";
          const priorityTag = priority >= 10 ? " [HIGH PRIORITY]" : "";
          memoriesLines.push(`- ${action.text} (category: ${category})${priorityTag}`);
        }
      }

      if (projectMemories.length > 0) {
        memoriesLines.push("\n## 💡 Past Project Context:");
        for (const memory of projectMemories) {
          memoriesLines.push(`- ${memory}`);
        }
      }

      const preferencesContext = memoriesLines.join("\n");
      const summaryMsg = `🧠 Retrieved ${retroActions.length} preferences and ${projectMemories.length} project memories`;

      if (retroActions.length > 0 || projectMemories.length > 0) {
        log(`${summaryMsg}. Context length: ${preferencesContext.length} chars`);
      }

      return {
        retrieved_memories: preferencesContext,
        preferences_context: preferencesContext,
        messages: [summaryMsg],
        last_action: "Memory retrieval complete",
        __node__: "memory_retrieval",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`❌ Memory retrieval failed: ${errMsg}`);
      return {
        retrieved_memories: "",
        preferences_context: "",
        messages: ["⚠️ Memory retrieval failed, proceeding without past context"],
        last_action: "Memory retrieval failed",
        __node__: "memory_retrieval",
      };
    }
  }
}

export function createMemoryRetrievalNode(
  vectorMemory: VectorMemory,
  maxRetroActions = 5,
  maxProjectMemories = 2
): (state: GraphState) => Promise<Partial<GraphState>> {
  const node = new MemoryRetrievalNode(vectorMemory, maxRetroActions, maxProjectMemories);
  return (state: GraphState) => node.retrieveMemories(state);
}
