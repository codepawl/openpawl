/**
 * Retrospective Agent - Sprint Retrospective analysis for TeamClaw.
 * 
 * Generates blame-free post-mortem analysis when rework was detected.
 * Focuses on system/process improvements rather than individual blame.
 */

import type { GraphState } from "../core/graph-state.js";
import type { VectorMemory } from "../core/knowledge-base.js";
import { logger, isDebugMode } from "../core/logger.js";
import { generate } from "../core/llm-client.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import { resolveModelForAgent } from "../core/model-config.js";
import { ensureWorkspaceDir } from "../core/workspace-fs.js";
import path from "node:path";
import fs from "node:fs";

export interface RetroResult {
    whatWentWell: string;
    whatDidntGoWell: string;
    actionItems: Array<{ text: string; category: string }>;
}

const RETRO_SYSTEM_PROMPT = `You are a Sprint Retrospective Facilitator for an AI development team.
RETURN ONLY RAW JSON. DO NOT INCLUDE PREAMBLE OR EXPLANATIONS. START WITH '{' AND END WITH '}'.

Your role is to analyze the team's recent work session and generate constructive, BLAME-FREE insights.

## Key Principles:
1. NEVER blame individuals - focus on SYSTEM and PROCESS improvements
2. Use "The system/process..." language, not "Maker failed to..."
3. Be constructive and actionable
4. Focus on preventing future issues

## Output Format:
Generate a JSON object with exactly this structure:
{
  "whatWentWell": "2-3 sentences about what worked well",
  "whatDidntGoWell": "2-3 sentences about blockers/reworks with process focus",
  "actionItems": [
    {"text": "action 1", "category": "styling"},
    {"text": "action 2", "category": "backend"},
    {"text": "action 3", "category": "error-handling"},
    {"text": "action 4", "category": "general"}
  ]
}

Categories: "styling", "backend", "error-handling", "general", "documentation", "testing", "architecture"

Example transformation:
- BAD: "Maker failed to validate CSS requirements"
- GOOD: "The system/process missed the requirement for modular CSS during planning, leading to rework. How can the Reviewer catch this during RFC?"

- BAD: "Reviewer missed the bug"
- GOOD: "The review process didn't catch the edge case. What checklist or validation step could catch this earlier?"`;

function log(msg: string): void {
    if (isDebugMode()) {
        logger.agent(msg);
    }
}

export class RetrospectiveAgent {
    private readonly vectorMemory: VectorMemory | null = null;

    constructor(vectorMemory: VectorMemory | null = null) {
        this.vectorMemory = vectorMemory;
    }

    async analyze(finalState: GraphState, workspacePath: string): Promise<RetroResult | null> {
        log("🔍 Running Sprint Retrospective analysis...");

        const tasks = (finalState.task_queue ?? []) as Array<{
            task_id: string;
            description: string;
            status: string;
            assigned_to?: string;
            review_feedback?: string;
        }>;

        const reworkedTasks = tasks.filter(t => t.status === "needs_rework" || t.status === "completed");

        if (reworkedTasks.length === 0) {
            log("No reworks detected, skipping retrospective.");
            return null;
        }

        const reworkDetails = reworkedTasks.map(t => {
            return `- Task: ${t.description.slice(0, 100)}
  Status: ${t.status}
  Feedback: ${t.review_feedback || "N/A"}`;
        }).join("\n");

        const prompt = `Analyze this sprint session:

## Tasks That Went Through Rework:
${reworkDetails}

## Team Context:
${(finalState.team ?? []).map(b => `- ${(b as { name: string }).name}: ${(b as { role_id: string }).role_id}`).join("\n")}

## Generate the retrospective in JSON format.`;

        let result: RetroResult;

        try {
            const response = await generate(RETRO_SYSTEM_PROMPT + "\n\n" + prompt, { botId: "retrospective", model: resolveModelForAgent("retrospective") });
            const parsed = parseLlmJson<Record<string, unknown>>(response);
            const actionItemsRaw = parsed.actionItems as unknown[] | undefined;
            const actionItems = Array.isArray(actionItemsRaw) 
                ? actionItemsRaw.map((item): { text: string; category: string } => {
                    if (typeof item === "string") return { text: item, category: "general" };
                    if (typeof item === "object" && item !== null) {
                        return { text: String((item as Record<string, unknown>).text || item), category: String((item as Record<string, unknown>).category || "general") };
                    }
                    return { text: String(item), category: "general" };
                  }).filter((item) => item.text)
                : [];
            result = {
                whatWentWell: String(parsed.whatWentWell || "Team completed the required work."),
                whatDidntGoWell: String(parsed.whatDidntGoWell || "Some rework was required."),
                actionItems,
            };
        } catch (err) {
            log(`⚠️ LLM retrospective failed: ${err}. Using fallback.`);
            result = this.generateFallbackRetro(reworkedTasks);
        }

        await this.saveToFile(result, workspacePath);

        if (this.vectorMemory && result.actionItems.length > 0) {
            await this.saveActionItemsToMemory(result.actionItems, finalState);
        }

        return result;
    }

    private generateFallbackRetro(reworkedTasks: Array<{ description: string; review_feedback?: string }>): RetroResult {
        const actionItems = reworkedTasks.map(t => {
            const feedback = t.review_feedback || "";
            if (feedback.toLowerCase().includes("css")) {
                return { text: "Add CSS validation checklist to RFC review process", category: "styling" };
            }
            if (feedback.toLowerCase().includes("test")) {
                return { text: "Include test coverage requirements in task definition", category: "testing" };
            }
            return { text: "Review task requirements more thoroughly during planning", category: "general" };
        });

        const uniqueItems = actionItems.filter((item, index, self) => 
            index === self.findIndex((t) => t.text === item.text)
        );

        return {
            whatWentWell: "Team successfully completed the sprint with required changes incorporated.",
            whatDidntGoWell: "The review process identified areas for improvement, resulting in rework cycles.",
            actionItems: uniqueItems
        };
    }

    private async saveToFile(result: RetroResult, workspacePath: string): Promise<void> {
        const docsDir = path.join(workspacePath, "docs");
        await ensureWorkspaceDir(docsDir);

        const retroPath = path.join(docsDir, "RETROSPECTIVE.md");

        const content = [
            "# Sprint Retrospective",
            "",
            `Generated: ${new Date().toISOString()}`,
            "",
            "## What Went Well",
            "",
            result.whatWentWell,
            "",
            "## What Didn't Go Well (Blockers/Reworks)",
            "",
            result.whatDidntGoWell,
            "",
            "## Action Items for Next Run",
            "",
            ...result.actionItems.map((item, i) => `${i + 1}. [${item.category}] ${item.text}`),
            "",
            "---",
            "*This retrospective was generated by TeamClaw. Focus on system improvements, not individual blame.*"
        ].join("\n");

        fs.writeFileSync(retroPath, content, "utf-8");
        log(`📝 Saved RETROSPECTIVE.md to ${retroPath}`);
    }

    private async saveActionItemsToMemory(
        actionItems: Array<{ text: string; category: string }>, 
        state: GraphState
    ): Promise<void> {
        if (!this.vectorMemory) return;

        for (const item of actionItems) {
            await this.vectorMemory.addRetroActionItem(item.text, {
                generation_id: state.generation_id,
                cycle_count: state.cycle_count,
                category: item.category,
                priority_score: 1,
                source: "ai_retrospective",
            });
        }
        log(`💾 Saved ${actionItems.length} action items to LanceDB (priority: 1)`);
    }
}
