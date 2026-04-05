/**
 * Export agents to shareable YAML files.
 */

import { writeFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import { Result, ok, err } from "neverthrow";
import type { ResolvedAgent, AgentCustomizationError } from "./types.js";

export class AgentExporter {
  exportToYaml(agent: ResolvedAgent): string {
    const header = [
      "# Agent definition for OpenPawl",
      `# Created: ${new Date().toISOString().split("T")[0]}`,
      `# Source: ${agent.source.type}`,
      "# Place this file in ~/.openpawl/agents/ to activate.",
      "",
    ].join("\n");

    const yamlContent = stringifyYaml(agent.rawYaml, { lineWidth: 120 });
    return header + yamlContent;
  }

  async exportToFile(
    agent: ResolvedAgent,
    filePath: string,
  ): Promise<Result<void, AgentCustomizationError>> {
    try {
      const content = this.exportToYaml(agent);
      await writeFile(filePath, content, "utf-8");
      return ok(undefined);
    } catch (e) {
      return err({ type: "io_error", cause: String(e) });
    }
  }

  exportResolved(agent: ResolvedAgent): string {
    return [
      `# Resolved agent: ${agent.id}`,
      `# Extends chain: ${agent.extendsChain.join(" → ") || "none"}`,
      "",
      "## Assembled system prompt:",
      agent.systemPrompt || "(empty)",
      "",
      `## Capabilities: ${agent.capabilities.join(", ") || "none"}`,
      `## Tools: ${agent.defaultTools.join(", ") || "none"}`,
      `## Excluded tools: ${agent.excludedTools.join(", ") || "none"}`,
      `## Model: ${agent.modelOverride ?? agent.modelTier}`,
      `## Trigger patterns: ${agent.triggerPatterns.length}`,
    ].join("\n");
  }
}
