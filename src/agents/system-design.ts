/**
 * System Design Node - Tech Lead creates architectural blueprint.
 * Acts as a Senior Software Architect to define system structure.
 */

import type { GraphState } from "../core/graph-state.js";
import type { WorkerAdapter } from "../adapters/worker-adapter.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { UniversalOpenClawAdapter } from "../adapters/worker-adapter.js";
import { resolveModelForAgent } from "../core/model-config.js";
import { ensureDir, writeTextFile } from "../core/workspace-fs.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import path from "node:path";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

const TECH_LEAD_SYSTEM_PROMPT = `You are a Senior Software Architect (Tech Lead) for an AI development team.
RETURN ONLY RAW JSON. DO NOT INCLUDE PREAMBLE OR EXPLANATIONS. START WITH '{' AND END WITH '}'.

Your role is to create a comprehensive system architecture blueprint that will guide all development work.

## Your Responsibilities:
1. Analyze the user's goal and sprint plan
2. Select appropriate tech stack with justification
3. Design component architecture and interactions
4. Define detailed directory structure
5. Specify security and error handling strategies
6. Document everything in ARCHITECTURE.md as the "Source of Truth"

## Output Format:
Generate a JSON object with this exact structure:
{
  "techStack": {
    "languages": ["language1", "language2"],
    "frameworks": ["framework1"],
    "databases": ["database1"],
    "tools": ["tool1"],
    "justification": "Why these choices fit the project goals"
  },
  "componentArchitecture": "How components interact (2-3 paragraphs)",
  "directoryStructure": "Tree view of project structure",
  "securityStrategy": "Security approach (1-2 paragraphs)",
  "errorHandlingStrategy": "Error handling approach (1-2 paragraphs)"
}`;

export class SystemDesignNode {
  private readonly llmAdapter: WorkerAdapter;
  private readonly workspacePath: string;
  private static readonly DESIGN_TIMEOUT_MS = CONFIG.llmTimeoutMs || 120_000;

  constructor(options: { llmAdapter?: WorkerAdapter; workspacePath?: string } = {}) {
    this.llmAdapter =
      options.llmAdapter ??
      new UniversalOpenClawAdapter({
        workerUrl: CONFIG.openclawWorkerUrl,
        authToken: CONFIG.openclawToken,
        model: resolveModelForAgent("architect"),
        botId: "architect",
      });
    this.workspacePath = options.workspacePath ?? process.cwd();
    log(`🏗️ SystemDesignNode initialized (workspace: ${this.workspacePath})`);
  }

  async processSystemDesign(state: GraphState, signal?: AbortSignal): Promise<Partial<GraphState>> {
    const userGoal = state.user_goal;
    const planningDoc = state.planning_document as string | undefined;

    if (!userGoal) {
      return {
        last_action: "No user goal provided for system design",
        __node__: "system_design",
      };
    }

    log("🏗️ [Tech Lead] Designing system architecture...");

    try {
      const architecture = await this.generateArchitectureWithLlm(userGoal, planningDoc, signal);
      await this.writeArchitectureDocument(architecture);

      log("✅ Architecture finalized at docs/ARCHITECTURE.md");

      return {
        architecture_document: architecture,
        messages: ["🏗️ System architecture complete. See DOCS/ARCHITECTURE.md"],
        last_action: "System design completed - architecture saved to docs/ARCHITECTURE.md",
        __node__: "system_design",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`❌ System design failed: ${errMsg}`);
      throw new Error(`System design failed: ${errMsg}`);
    }
  }

  private async generateArchitectureWithLlm(
    goal: string,
    planningDoc?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const planningContent = planningDoc 
      ? `\n## Sprint Plan:\n${planningDoc.slice(0, 2000)}`
      : "";

    const prompt = `Create the system architecture for this project:

## User Goal:
${goal}
${planningContent}

## Generate the architecture in JSON format.`;

    const messages = [
      { role: "system", content: TECH_LEAD_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    return new Promise((resolve, reject) => {
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error("System design timed out"));
        }
      }, SystemDesignNode.DESIGN_TIMEOUT_MS);

      // Abort signal support
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeoutId);
          reject(new Error("Aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(new Error("Aborted"));
          }
        }, { once: true });
      }

      this.llmAdapter
        .executeTask({
          task_id: `design-${Date.now()}`,
          description: JSON.stringify(messages),
          priority: "HIGH",
          estimated_cost: 0,
        }, { signal })
        .then((result) => {
          clearTimeout(timeoutId);
          if (!resolved) {
            resolved = true;
            if (result.success) {
              resolve(result.output ?? "");
            } else {
              reject(new Error(result.output ?? "Architecture generation failed"));
            }
          }
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
    });
  }

  private async writeArchitectureDocument(architectureJson: string): Promise<void> {
    const docsDir = path.join(this.workspacePath, "docs");
    await ensureDir(docsDir);

    let parsed: Record<string, unknown>;
    try {
      parsed = parseLlmJson<Record<string, unknown>>(architectureJson);
    } catch {
      parsed = { raw: architectureJson };
    }

    const techStack = parsed.techStack as Record<string, unknown> | undefined;
    const components = parsed.componentArchitecture as string | undefined;
    const directory = parsed.directoryStructure as string | undefined;
    const security = parsed.securityStrategy as string | undefined;
    const errorHandling = parsed.errorHandlingStrategy as string | undefined;

    const content = [
      "# System Architecture",
      "",
      `*Generated by Tech Lead on ${new Date().toISOString()}*`,
      "",
      "## ⚠️ SOURCE OF TRUTH",
      "",
      "This document is the **authoritative source** for all technical decisions.",
      "All team members (Maker, Reviewer, Coordinator) MUST follow this architecture.",
      "Any deviation requires approval from the Tech Lead.",
      "",
      "---",
      "",
      "## Tech Stack Selection",
      "",
      techStack?.justification 
        ? `**Justification:** ${techStack.justification}`
        : "",
      "",
      techStack?.languages 
        ? `- **Languages:** ${(techStack.languages as string[]).join(", ")}`
        : "",
      "",
      techStack?.frameworks 
        ? `- **Frameworks:** ${(techStack.frameworks as string[]).join(", ")}`
        : "",
      "",
      techStack?.databases 
        ? `- **Databases:** ${(techStack.databases as string[]).join(", ")}`
        : "",
      "",
      techStack?.tools 
        ? `- **Tools:** ${(techStack.tools as string[]).join(", ")}`
        : "",
      "",
      "---",
      "",
      "## Component Architecture",
      "",
      components || "See raw output",
      "",
      "---",
      "",
      "## Directory Structure",
      "",
      "```",
      directory || "project/",
      "```",
      "",
      "---",
      "",
      "## Security Strategy",
      "",
      security || "To be documented",
      "",
      "---",
      "",
      "## Error Handling Strategy",
      "",
      errorHandling || "To be documented",
      "",
      "---",
      "",
      "*This architecture document was generated by TeamClaw's Tech Lead.*",
    ].join("\n");

    const filePath = path.join(docsDir, "ARCHITECTURE.md");
    await writeTextFile("docs/ARCHITECTURE.md", content, {
      workspaceDir: this.workspacePath,
      mkdirp: true,
    });

    log(`📝 Wrote ARCHITECTURE.md to ${filePath}`);
  }
}

export function createSystemDesignNode(
  workspacePath: string,
  llmAdapter?: WorkerAdapter,
  signal?: AbortSignal
): (state: GraphState) => Promise<Partial<GraphState>> {
  const node = new SystemDesignNode({ llmAdapter, workspacePath });
  return (state: GraphState) => node.processSystemDesign(state, signal);
}
