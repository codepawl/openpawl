/**
 * Resolve agent inheritance chains (extends).
 */

import { Result, ok, err } from "neverthrow";
import type { AgentYaml, AgentSource, ResolvedAgent, ResolvedPersonality, AgentCustomizationError } from "./types.js";
import type { AgentDefinition } from "../../router/router-types.js";

const MAX_DEPTH = 3;

export class InheritanceResolver {
  constructor(private builtInAgents: Map<string, AgentDefinition>) {}

  resolve(
    yaml: AgentYaml,
    allYamls: Map<string, AgentYaml>,
    source: AgentSource,
    visited: Set<string> = new Set(),
  ): Result<ResolvedAgent, AgentCustomizationError> {
    // Circular check
    if (visited.has(yaml.id)) {
      return err({ type: "circular_inheritance", chain: [...visited, yaml.id] });
    }
    visited.add(yaml.id);

    // Depth check
    if (visited.size > MAX_DEPTH) {
      return err({ type: "max_depth_exceeded", agentId: yaml.id, depth: visited.size });
    }

    // Resolve parent
    let parentResolved: ResolvedAgent | null = null;
    if (yaml.extends) {
      // Check custom agents first, then built-in
      const parentYaml = allYamls.get(yaml.extends);
      if (parentYaml) {
        const parentResult = this.resolve(parentYaml, allYamls, source, new Set(visited));
        if (parentResult.isErr()) return parentResult;
        parentResolved = parentResult.value;
      } else {
        // Try built-in
        const builtIn = this.builtInAgents.get(yaml.extends);
        if (!builtIn) {
          return err({ type: "inheritance_error", agentId: yaml.id, cause: `Parent '${yaml.extends}' not found` });
        }
        parentResolved = builtInToResolved(builtIn);
      }
    }

    return ok(mergeWithParent(yaml, parentResolved, source));
  }

  resolveAll(
    yamls: Map<string, { yaml: AgentYaml; source: AgentSource }>,
  ): Result<Map<string, ResolvedAgent>, AgentCustomizationError> {
    const allYamls = new Map<string, AgentYaml>();
    for (const [id, { yaml }] of yamls) allYamls.set(id, yaml);

    const resolved = new Map<string, ResolvedAgent>();

    // Resolve in dependency order (parents first)
    for (const [id, { yaml, source }] of yamls) {
      const result = this.resolve(yaml, allYamls, source);
      if (result.isErr()) continue; // Skip problematic agents
      resolved.set(id, result.value);
    }

    return ok(resolved);
  }
}

function mergeWithParent(yaml: AgentYaml, parent: ResolvedAgent | null, source: AgentSource): ResolvedAgent {
  const caps = dedupe([...(yaml.capabilities ?? []), ...(parent?.capabilities ?? [])]);
  const tools = dedupe([...(yaml.tools?.include ?? []), ...(parent?.defaultTools ?? [])]);
  const excluded = yaml.tools?.exclude ?? [];

  // Prompt resolution
  let systemPrompt = "";
  if (yaml.prompt?.system) {
    systemPrompt = yaml.prompt.system;
  } else if (yaml.prompt?.prepend && parent) {
    systemPrompt = yaml.prompt.prepend + "\n\n" + parent.systemPrompt;
  } else if (yaml.prompt?.append && parent) {
    systemPrompt = parent.systemPrompt + "\n\n" + yaml.prompt.append;
  } else if (parent) {
    systemPrompt = parent.systemPrompt;
  }

  // Personality
  let personality: ResolvedPersonality | undefined;
  if (yaml.personality || parent?.personality) {
    personality = {
      traits: dedupe([...(yaml.personality?.traits ?? []), ...(parent?.personality?.traits ?? [])]),
      tone: yaml.personality?.communicationStyle?.tone ?? parent?.personality?.tone ?? "collaborative",
      verbosity: yaml.personality?.communicationStyle?.verbosity ?? parent?.personality?.verbosity ?? "moderate",
      opinions: [
        ...(yaml.personality?.opinions?.map((o) => ({ ...o, strength: o.strength ?? "moderate" })) ?? []),
        ...(parent?.personality?.opinions ?? []),
      ],
      pushbackTriggers: [
        ...(yaml.personality?.pushbackTriggers?.map((t) => ({ ...t, severity: t.severity ?? "warn" })) ?? []),
        ...(parent?.personality?.pushbackTriggers ?? []),
      ],
      catchphrases: [...(yaml.personality?.catchphrases ?? []), ...(parent?.personality?.catchphrases ?? [])],
    };
  }

  return {
    id: yaml.id,
    name: yaml.name,
    description: yaml.description,
    source,
    capabilities: caps,
    defaultTools: tools.filter((t) => !excluded.includes(t)),
    excludedTools: excluded,
    modelTier: yaml.model?.tier ?? parent?.modelTier ?? "primary",
    modelOverride: yaml.model?.override ?? parent?.modelOverride,
    modelProvider: yaml.model?.provider ?? parent?.modelProvider,
    systemPrompt,
    personality,
    triggerPatterns: yaml.behavior?.triggerPatterns ?? parent?.triggerPatterns ?? [],
    canCollaborate: yaml.behavior?.canCollaborate ?? parent?.canCollaborate ?? true,
    maxConcurrent: yaml.behavior?.maxConcurrent ?? parent?.maxConcurrent ?? 2,
    confirmDestructive: yaml.behavior?.confirmDestructive ?? true,
    meta: yaml.meta,
    extendsChain: yaml.extends ? [yaml.extends, ...(parent?.extendsChain ?? [])] : [],
    rawYaml: yaml,
  };
}

function builtInToResolved(def: AgentDefinition): ResolvedAgent {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    source: { type: "built-in" },
    capabilities: def.capabilities,
    defaultTools: def.defaultTools,
    excludedTools: [],
    modelTier: def.modelTier,
    systemPrompt: def.systemPrompt,
    triggerPatterns: def.triggerPatterns ?? [],
    canCollaborate: def.canCollaborate,
    maxConcurrent: def.maxConcurrent,
    confirmDestructive: true,
    extendsChain: [],
    rawYaml: { id: def.id, name: def.name, description: def.description },
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
