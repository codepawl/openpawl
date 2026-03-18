/**
 * Local template store — manages installed templates on disk.
 * Templates installed at ~/.teamclaw/templates/installed/<id>/template.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TeamClawTemplate, InstalledTemplate } from "./types.js";

function getInstalledDir(): string {
  return path.join(os.homedir(), ".teamclaw", "templates", "installed");
}

function getTemplatePath(id: string): string {
  return path.join(getInstalledDir(), id, "template.json");
}

function getTemplateDir(id: string): string {
  return path.join(getInstalledDir(), id);
}

export class LocalTemplateStore {
  async install(template: TeamClawTemplate): Promise<void> {
    const dir = getTemplateDir(template.id);
    mkdirSync(dir, { recursive: true });
    const installed: InstalledTemplate = {
      ...template,
      installedAt: Date.now(),
      installedVersion: template.version,
    };
    writeFileSync(getTemplatePath(template.id), JSON.stringify(installed, null, 2));
  }

  async uninstall(id: string): Promise<boolean> {
    const dir = getTemplateDir(id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async list(): Promise<InstalledTemplate[]> {
    const dir = getInstalledDir();
    if (!existsSync(dir)) return [];
    const result: InstalledTemplate[] = [];
    try {
      for (const entry of readdirSync(dir)) {
        const p = getTemplatePath(entry);
        if (!existsSync(p)) continue;
        try {
          result.push(JSON.parse(readFileSync(p, "utf-8")) as InstalledTemplate);
        } catch {
          // skip corrupt
        }
      }
    } catch {
      // dir read failed
    }
    return result;
  }

  async get(id: string): Promise<InstalledTemplate | null> {
    const p = getTemplatePath(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as InstalledTemplate;
    } catch {
      return null;
    }
  }

  async isInstalled(id: string): Promise<boolean> {
    return existsSync(getTemplatePath(id));
  }
}
