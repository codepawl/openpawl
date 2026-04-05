/**
 * Import agents from external sources (URLs, git repos).
 * YAML-only — never executes external code.
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Result, ok, err } from "neverthrow";
import { parse as parseYaml } from "yaml";
import { AgentYamlSchema } from "./types.js";
import type { AgentCustomizationError } from "./types.js";

export interface CommunityAgent {
  id: string;
  source: string;
  installedAt: string;
  filePath: string;
}

export class CommunityAgentLoader {
  private registryPath: string;

  constructor(private installDir: string) {
    this.registryPath = path.join(installDir, "registry.json");
  }

  async importFromUrl(url: string): Promise<Result<string, AgentCustomizationError>> {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return err({ type: "community_error", source: url, cause: `HTTP ${resp.status}` });

      const raw = await resp.text();
      const parsed = parseYaml(raw);
      const validated = AgentYamlSchema.safeParse(parsed);
      if (!validated.success) {
        return err({ type: "community_error", source: url, cause: "Invalid agent YAML" });
      }

      const yaml = validated.data;
      await mkdir(this.installDir, { recursive: true });
      const filePath = path.join(this.installDir, `${yaml.id}.yaml`);
      await writeFile(filePath, raw, "utf-8");

      await this.addToRegistry({ id: yaml.id, source: url, installedAt: new Date().toISOString(), filePath });
      return ok(yaml.id);
    } catch (e) {
      return err({ type: "community_error", source: url, cause: String(e) });
    }
  }

  async importFromGit(repoUrl: string): Promise<Result<string[], AgentCustomizationError>> {
    // Simplified: delegate to URL import for individual files
    // Full git clone support is a v2 enhancement
    return err({ type: "community_error", source: repoUrl, cause: "Git import not yet implemented. Use URL import for individual files." });
  }

  list(): CommunityAgent[] {
    try {
      if (!existsSync(this.registryPath)) return [];
      const raw = readFileSync(this.registryPath, "utf-8");
      return JSON.parse(raw) as CommunityAgent[];
    } catch {
      return [];
    }
  }

  async remove(agentId: string): Promise<Result<void, AgentCustomizationError>> {
    try {
      const registry = this.list();
      const agent = registry.find((a) => a.id === agentId);
      if (!agent) return err({ type: "community_error", source: agentId, cause: "Agent not found" });

      if (existsSync(agent.filePath)) {
        await rm(agent.filePath);
      }

      const updated = registry.filter((a) => a.id !== agentId);
      await writeFile(this.registryPath, JSON.stringify(updated, null, 2), "utf-8");
      return ok(undefined);
    } catch (e) {
      return err({ type: "community_error", source: agentId, cause: String(e) });
    }
  }

  private async addToRegistry(agent: CommunityAgent): Promise<void> {
    const registry = this.list();
    const existing = registry.findIndex((a) => a.id === agent.id);
    if (existing >= 0) {
      registry[existing] = agent;
    } else {
      registry.push(agent);
    }
    await writeFile(this.registryPath, JSON.stringify(registry, null, 2), "utf-8");
  }
}
