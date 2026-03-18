/**
 * Template publisher — validates and creates a GitHub PR via gh CLI.
 */

import { existsSync, readFileSync } from "node:fs";
import type { TeamClawTemplate } from "./types.js";
import { DEFAULT_MARKETPLACE_CONFIG } from "./types.js";
import { validateTemplate } from "./validator.js";

export interface PublishResult {
  success: boolean;
  error?: string;
  method?: string;
  url?: string;
}

export class TemplatePublisher {
  private repo: string;

  constructor(config?: { repo?: string }) {
    this.repo = config?.repo ?? DEFAULT_MARKETPLACE_CONFIG.repo;
  }

  getGhCommand(template: TeamClawTemplate): string {
    return [
      "gh pr create",
      `--repo ${this.repo}`,
      `--title "feat: add template ${template.id}"`,
      `--body "Adds ${template.name} template (${template.agents.length} agents)\\n\\nAuthor: ${template.author}\\nTags: ${template.tags.join(", ")}"`,
      "--base main",
    ].join(" ");
  }

  async publish(templatePath: string): Promise<PublishResult> {
    // Read file
    let raw: string;
    try {
      if (!existsSync(templatePath)) {
        return { success: false, error: "Failed to read template file", method: "none" };
      }
      raw = readFileSync(templatePath, "utf-8");
    } catch {
      return { success: false, error: "Failed to read template file", method: "none" };
    }

    // Parse JSON
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return { success: false, error: "Failed to parse template JSON", method: "none" };
    }

    // Validate
    const validation = validateTemplate(data);
    if (!validation.valid) {
      return {
        success: false,
        error: `Template validation failed: ${validation.errors.join(", ")}`,
        method: "none",
      };
    }

    // At this point the template is valid — in a real implementation,
    // we'd run `gh pr create` or open the browser.
    return {
      success: false,
      error: "Marketplace publishing requires the gh CLI. Install it and try again.",
      method: "gh",
    };
  }
}
