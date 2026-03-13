/**
 * RFC Node - Request for Comments for complex tasks.
 * Maker writes RFC, Reviewer approves before execution.
 */

import type { GraphState } from "../core/graph-state.js";
import type { BotDefinition } from "../core/bot-definitions.js";
import type { WorkerAdapter } from "../interfaces/worker-adapter.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import { UniversalOpenClawAdapter } from "../interfaces/worker-adapter.js";
import { writeTextFile, readTextFile } from "../core/workspace-fs.js";
import { getCanvasTelemetry } from "../core/canvas-telemetry.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

interface RFCEntry {
  taskId: string;
  taskDescription: string;
  status: "pending" | "approved" | "rejected" | "revision_needed";
  maker: string;
  reviewer: string | null;
  complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE";
  technicalApproach: string;
  tools: string[];
  fileStructure: string;
  feedback: string;
  createdAt: string;
  updatedAt: string;
}

export class RFCNode {
  private readonly llmAdapter: WorkerAdapter;
  private readonly workspacePath: string;
  private readonly team: BotDefinition[];
  private static readonly RFC_TIMEOUT_MS = 45_000;

  constructor(
    options: { llmAdapter?: WorkerAdapter; workspacePath?: string; team?: BotDefinition[] } = {}
  ) {
    this.llmAdapter =
      options.llmAdapter ??
      new UniversalOpenClawAdapter({
        workerUrl: CONFIG.openclawWorkerUrl,
        authToken: CONFIG.openclawToken,
      });
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.team = options.team ?? [];
    log(`📝 RFCNode initialized (workspace: ${this.workspacePath})`);
  }

  async processRFCPhase(state: GraphState): Promise<Partial<GraphState>> {
    const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
    const messages: string[] = [];
    
    const makerBot = this.team.find((b) => b.role_id === "software_engineer");
    const reviewerBot = this.team.find((b) => b.role_id === "qa_reviewer");

    const needsRfc = taskQueue.filter(
      (t) =>
        t.status === "planning" &&
        (t.complexity === "HIGH" || t.complexity === "ARCHITECTURE")
    );

    if (needsRfc.length === 0) {
      const updatedQueue = taskQueue.map((t) => ({
        ...t,
        status: t.status === "planning" ? "pending" : t.status,
      }));
      return {
        task_queue: updatedQueue,
        messages: ["📝 No complex tasks require RFC. Proceeding to execution."],
        last_action: "RFC phase complete - no RFCs needed",
        __node__: "rfc_phase",
      };
    }

    log(`📝 Processing RFCs for ${needsRfc.length} complex tasks`);

    for (const task of needsRfc) {
      const taskId = (task.task_id as string) ?? "UNKNOWN";
      const description = (task.description as string) ?? "";
      const makerId = makerBot?.id ?? "bot_0";
      const reviewerId = reviewerBot?.id ?? "bot_1";

      try {
        const rfcEntry = await this.createRFCForTask(
          taskId,
          description,
          makerId,
          reviewerId,
          (task.complexity as string) || "HIGH"
        );

        await this.appendRfcToLog(rfcEntry);

        // Send telemetry event
        try {
          const telemetry = getCanvasTelemetry();
          telemetry.sendRFCEvent(taskId, "created", rfcEntry.complexity);
        } catch {
          // Non-critical, ignore
        }

        messages.push(
          `📝 [${taskId}] RFC created by ${makerId} - awaiting ${reviewerId} approval`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`❌ RFC creation failed for ${taskId}: ${errMsg}`);
        messages.push(`⚠️ [${taskId}] RFC skipped due to error: ${errMsg}`);
      }
    }

    const updatedQueue = taskQueue.map((t) => {
      if (
        t.status === "planning" &&
        (t.complexity === "HIGH" || t.complexity === "ARCHITECTURE")
      ) {
        return { ...t, status: "rfc_pending" as const };
      }
      if (t.status === "planning") {
        return { ...t, status: "pending" as const };
      }
      return t;
    });

    const rfcLog = await this.readRfcLog();

    return {
      task_queue: updatedQueue,
      rfc_document: rfcLog,
      messages,
      last_action: `RFC phase complete - ${needsRfc.length} RFCs created`,
      __node__: "rfc_phase",
    };
  }

  async processRFCApproval(
    taskId: string,
    feedback: string,
    approved: boolean
  ): Promise<Partial<GraphState>> {
    try {
      const existingLog = await this.readRfcLog();
      const updatedLog = this.updateRfcStatus(existingLog, taskId, feedback, approved);
      
      await writeTextFile("DOCS/RFC.md", updatedLog, {
        workspaceDir: this.workspacePath,
        mkdirp: true,
      });

      // Send telemetry event
      try {
        const telemetry = getCanvasTelemetry();
        telemetry.sendRFCEvent(taskId, approved ? "approved" : "rejected", "HIGH");
      } catch {
        // Non-critical, ignore
      }

      log(`✅ RFC ${taskId} ${approved ? "approved" : "rejected"}`);

      return {
        rfc_document: updatedLog,
        last_action: `RFC ${taskId} ${approved ? "approved" : "rejected"}`,
        __node__: "rfc_approval",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`RFC approval failed: ${errMsg}`);
    }
  }

  private async createRFCForTask(
    taskId: string,
    description: string,
    makerId: string,
    reviewerId: string,
    complexity: string
  ): Promise<RFCEntry> {
    const prompt = `You are a Software Engineer (Maker) creating an RFC for this task.

CRITICAL: Before writing the RFC, you MUST read docs/ARCHITECTURE.md.
Your RFC MUST align with the architecture, folder structure, and tech stack 
defined by the Tech Lead in docs/ARCHITECTURE.md.

## Task
${description}

## Your Task
Write a brief RFC (Request for Comments) with:

1. **Technical Approach**: How will you implement this? (Logic flow, algorithms)
2. **Tools**: What tools/frameworks will you use?
3. **File Structure**: Proposed file organization

Output ONLY a JSON object:
{
  "technicalApproach": "string describing logic",
  "tools": ["tool1", "tool2"],
  "fileStructure": "src/\n├── file1.ts\n└── file2.ts"
}`;

    const llmTaskId = `RFC-${taskId}-${Date.now()}`;
    const llmResult = await Promise.race([
      this.llmAdapter.executeTask({
        task_id: llmTaskId,
        description: prompt,
        priority: "HIGH",
        estimated_cost: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("RFC creation timed out")),
          RFCNode.RFC_TIMEOUT_MS
        )
      ),
    ]);

    if (!llmResult.success) {
      throw new Error(String(llmResult.output ?? "RFC creation failed"));
    }

    const raw = String(llmResult.output ?? "").trim();
    const parsed = parseLlmJson<{
      technicalApproach: string;
      tools: string[];
      fileStructure: string;
    }>(raw);

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    return {
      taskId,
      taskDescription: description,
      status: "pending",
      maker: makerId,
      reviewer: reviewerId,
      complexity: (complexity as "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE") || "HIGH",
      technicalApproach: parsed?.technicalApproach ?? "No approach specified",
      tools: parsed?.tools ?? [],
      fileStructure: parsed?.fileStructure ?? "To be determined",
      feedback: "",
      createdAt: now,
      updatedAt: now,
    };
  }

  private formatRfcEntry(entry: RFCEntry): string {
    const statusEmoji =
      entry.status === "approved"
        ? "🟢"
        : entry.status === "rejected"
        ? "🔴"
        : entry.status === "revision_needed"
        ? "🟠"
        : "🟡";

    const toolsList = entry.tools.length > 0 ? entry.tools.join(", ") : "None specified";

    return `## ${statusEmoji} ${entry.taskId}: ${entry.taskDescription.slice(0, 60)}${entry.taskDescription.length > 60 ? "..." : ""}

| Field | Value |
|-------|-------|
| **Status** | ${statusEmoji} ${entry.status.toUpperCase()} |
| **Maker** | ${entry.maker} |
| **Reviewer** | ${entry.reviewer ?? "Awaiting"} |
| **Complexity** | ${entry.complexity} |
| **Created** | ${entry.createdAt} |
| **Updated** | ${entry.updatedAt} |

### Technical Approach

**Logic:**
> ${entry.technicalApproach}

**Tools:**
> ${toolsList}

**File Structure:**
\`\`\`
${entry.fileStructure}
\`\`\`

### Reviewer Feedback

> ${entry.feedback || "Awaiting review..."}

---
`;
  }

  private async readRfcLog(): Promise<string> {
    try {
      return await readTextFile("DOCS/RFC.md", {
        workspaceDir: this.workspacePath,
      });
    } catch {
      return "# 📝 RFC Log\n\n---\n";
    }
  }

  private updateRfcStatus(
    existingLog: string,
    taskId: string,
    feedback: string,
    approved: boolean
  ): string {
    const lines = existingLog.split("\n");
    let inTaskSection = false;
    const newLines: string[] = [];
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    for (const line of lines) {
      if (line.includes(`## ${taskId}:`)) {
        inTaskSection = true;
        newLines.push(line);
      } else if (inTaskSection && line.startsWith("| **Status**")) {
        const status = approved ? "🟢 APPROVED" : "🔴 REJECTED";
        newLines.push(`| **Status** | ${status} |`);
      } else if (inTaskSection && line.startsWith("| **Updated**")) {
        newLines.push(`| **Updated** | ${now} |`);
      } else if (inTaskSection && line.startsWith("> ") && line.includes("Awaiting")) {
        newLines.push(`> ${feedback || (approved ? "Approved" : "Needs revision")}`);
      } else if (inTaskSection && line.startsWith("---")) {
        inTaskSection = false;
        newLines.push(line);
      } else {
        newLines.push(line);
      }
    }

    return newLines.join("\n");
  }

  private async appendRfcToLog(entry: RFCEntry): Promise<void> {
    const existingLog = await this.readRfcLog();
    const newEntry = this.formatRfcEntry(entry);
    const updatedLog = existingLog + "\n" + newEntry;

    await writeTextFile("DOCS/RFC.md", updatedLog, {
      workspaceDir: this.workspacePath,
      mkdirp: true,
    });

    log(`✅ Appended ${entry.taskId} to DOCS/RFC.md`);
  }
}

export function createRFCNode(
  workspacePath: string,
  team: BotDefinition[],
  llmAdapter?: WorkerAdapter
): (state: GraphState) => Promise<Partial<GraphState>> {
  const node = new RFCNode({ llmAdapter, workspacePath, team });
  return (state: GraphState) => node.processRFCPhase(state);
}
