/**
 * Load agent YAML definitions from directories with priority ordering.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { Result, ok, err } from "neverthrow";
import { AgentYamlSchema } from "./types.js";
import type { AgentYaml, AgentSource, AgentDirectory, AgentCustomizationError } from "./types.js";

export interface LoadResult {
  agents: Map<string, { yaml: AgentYaml; source: AgentSource }>;
  errors: Array<{ file: string; error: string }>;
}

export class AgentYamlLoader {
  async loadFile(
    filePath: string,
    _sourceType: AgentSource["type"],
  ): Promise<Result<AgentYaml, AgentCustomizationError>> {
    try {
      const raw = await readFile(filePath, "utf-8");
      let parsed: unknown;

      if (filePath.endsWith(".json")) {
        parsed = JSON.parse(raw);
      } else {
        parsed = parseYaml(raw);
      }

      const result = AgentYamlSchema.safeParse(parsed);
      if (!result.success) {
        const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
        return err({ type: "schema_validation", file: filePath, errors });
      }

      return ok(result.data);
    } catch (e) {
      return err({ type: "invalid_yaml", file: filePath, cause: String(e) });
    }
  }

  async loadDirectory(
    dirPath: string,
    sourceType: AgentSource["type"],
  ): Promise<Result<AgentYaml[], AgentCustomizationError>> {
    if (!existsSync(dirPath)) return ok([]);

    const files = await readdir(dirPath);
    const yamls: AgentYaml[] = [];

    for (const file of files) {
      if (file.startsWith(".") || file.startsWith("_")) continue;
      if (!file.endsWith(".yaml") && !file.endsWith(".yml") && !file.endsWith(".json")) continue;

      const filePath = path.join(dirPath, file);
      const result = await this.loadFile(filePath, sourceType);
      if (result.isOk()) {
        yamls.push(result.value);
      }
      // Invalid files silently skipped (logged at caller level)
    }

    return ok(yamls);
  }

  async loadAll(directories: AgentDirectory[]): Promise<Result<LoadResult, AgentCustomizationError>> {
    const agents = new Map<string, { yaml: AgentYaml; source: AgentSource }>();
    const errors: Array<{ file: string; error: string }> = [];

    // Sort by priority (lower = higher priority = loaded last = wins)
    const sorted = [...directories].sort((a, b) => b.priority - a.priority);

    for (const dir of sorted) {
      if (!existsSync(dir.path)) continue;

      let files: string[];
      try {
        files = await readdir(dir.path);
      } catch {
        continue;
      }

      for (const file of files) {
        if (file.startsWith(".") || file.startsWith("_")) continue;
        if (!file.endsWith(".yaml") && !file.endsWith(".yml") && !file.endsWith(".json")) continue;

        const filePath = path.join(dir.path, file);
        const result = await this.loadFile(filePath, dir.source);

        if (result.isOk()) {
          const yaml = result.value;
          const source: AgentSource = dir.source === "user"
            ? { type: "user", filePath }
            : dir.source === "project"
              ? { type: "project", filePath }
              : dir.source === "community"
                ? { type: "community", packageName: file }
                : { type: "built-in" };
          agents.set(yaml.id, { yaml, source });
        } else {
          errors.push({ file: filePath, error: result.error.type });
        }
      }
    }

    return ok({ agents, errors });
  }
}
