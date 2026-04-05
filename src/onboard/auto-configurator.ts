/**
 * Generate config suggestions from project analysis.
 */

import type { ProjectAnalysis } from "./project-analyzer.js";
import type { ToolPermissionConfig } from "../tools/types.js";

export interface ConfigSuggestions {
  agents: AgentSuggestion[];
  toolPermissions: Partial<ToolPermissionConfig>;
  promptRules: string[];
  ignorePaths: string[];
}

export interface AgentSuggestion {
  agentId: string;
  reason: string;
  autoEnable: boolean;
}

export function generateSuggestions(analysis: ProjectAnalysis): ConfigSuggestions {
  const agents: AgentSuggestion[] = [];
  const promptRules: string[] = [];
  const ignorePaths: string[] = [];

  // Always suggest coder
  agents.push({ agentId: "coder", reason: "Core coding agent", autoEnable: true });

  // TypeScript/JavaScript project
  if (analysis.language === "typescript" || analysis.language === "javascript") {
    agents.push({ agentId: "reviewer", reason: "Code review for quality", autoEnable: true });
    if (analysis.language === "typescript") {
      promptRules.push("Use TypeScript strict mode");
    }
  }

  // Test runner detected
  if (analysis.testRunner) {
    agents.push({ agentId: "tester", reason: `${analysis.testRunner} test runner detected`, autoEnable: true });
    promptRules.push(`Test with ${analysis.testRunner}`);
  } else if (!analysis.hasTests) {
    agents.push({ agentId: "tester", reason: "No tests detected — suggest adding them", autoEnable: true });
    promptRules.push("This project has no tests yet — always suggest adding them");
  }

  // Framework-specific
  if (analysis.framework === "express" || analysis.framework === "fastify") {
    promptRules.push(`Follow REST conventions for this ${analysis.framework} API`);
  }
  if (analysis.framework === "nextjs") {
    promptRules.push("Use Next.js App Router patterns");
  }

  // Large project → planner
  if (analysis.estimatedSize === "large") {
    agents.push({ agentId: "planner", reason: "Large project — navigation help", autoEnable: true });
  }

  // CI detected
  if (analysis.hasCI) {
    promptRules.push("Changes must pass CI");
  }

  // Linter detected
  if (analysis.linter) {
    promptRules.push(`Follow ${analysis.linter} rules`);
  }

  // Convention rules
  if (analysis.conventions.indentation !== "unknown") {
    promptRules.push(`Use ${analysis.conventions.indentation} indentation`);
  }

  // Default ignore paths
  ignorePaths.push("node_modules/", ".git/", "dist/", "build/", ".env", "*.key", "*.pem");

  return { agents, toolPermissions: {}, promptRules, ignorePaths };
}
