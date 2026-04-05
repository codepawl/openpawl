/**
 * Assembles the final system prompt from agent definition parts.
 */

import type { ResolvedAgent } from "./types.js";

export class AgentPromptBuilder {
  build(agent: ResolvedAgent): string {
    const parts: string[] = [];

    // Base prompt
    parts.push(agent.systemPrompt || `You are ${agent.name}. ${agent.description}`);

    // Rules injection
    if (agent.rawYaml.prompt?.rules?.length) {
      parts.push("\n## Rules you must follow:");
      for (const rule of agent.rawYaml.prompt.rules) {
        parts.push(`- ${rule}`);
      }
    }

    // Personality injection
    if (agent.personality) {
      const p = agent.personality;
      parts.push("\n## Your character");
      if (p.traits.length) {
        parts.push(`You are ${agent.name}. Your traits: ${p.traits.join(", ")}.`);
      }
      if (p.tone || p.verbosity) {
        parts.push(`Communication: ${p.tone ?? "collaborative"}, ${p.verbosity ?? "moderate"}.`);
      }
      if (p.opinions.length) {
        parts.push("Strong opinions:");
        for (const op of p.opinions) {
          parts.push(`- ${op.topic}: ${op.stance}`);
        }
      }
    }

    return parts.join("\n");
  }

  buildWithContext(
    agent: ResolvedAgent,
    context: {
      sessionTitle?: string;
      workingDirectory?: string;
      projectType?: string;
      trackedFiles?: string[];
    },
  ): string {
    const base = this.build(agent);
    const ctx: string[] = [base, "\n## Current context"];

    if (context.projectType) ctx.push(`Project: ${context.projectType}`);
    if (context.workingDirectory) ctx.push(`Working directory: ${context.workingDirectory}`);
    if (context.sessionTitle) ctx.push(`Session: ${context.sessionTitle}`);
    if (context.trackedFiles?.length) {
      ctx.push(`Files in context: ${context.trackedFiles.slice(0, 10).join(", ")}`);
    }

    return ctx.join("\n");
  }
}
