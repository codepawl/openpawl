/**
 * TeamClaw check — comprehensive system check with actionable output.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { intro, note, outro, spinner } from "@clack/prompts";
import pc from "picocolors";

import { logger } from "./core/logger.js";
import { getGlobalProviderManager } from "./providers/provider-factory.js";
import { randomPhrase } from "./utils/spinner-phrases.js";

export async function runCheck(_args: string[]): Promise<void> {
  const canRenderSpinner = Boolean(process.stdout.isTTY && process.stderr.isTTY);

  if (canRenderSpinner) {
    intro("TeamClaw System Check");
  } else {
    logger.plain("TeamClaw System Check\n");
  }

  const issues: string[] = [];
  const lines: string[] = [];

  // Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  if (nodeMajor >= 20) {
    lines.push(`  ${pc.green("✓")}  Node.js      ${nodeVersion} ${pc.dim("(required: >=20)")}`);
  } else {
    lines.push(`  ${pc.red("✗")}  Node.js      ${nodeVersion} ${pc.red("(required: >=20)")}`);
    issues.push("Node.js version must be >= 20");
  }

  // Config file
  const configPath = path.join(os.homedir(), ".teamclaw", "config.json");
  if (existsSync(configPath)) {
    lines.push(`  ${pc.green("✓")}  Config       ~/.teamclaw/config.json`);
  } else {
    lines.push(`  ${pc.red("✗")}  Config       ${pc.dim("Not found")}`);
    issues.push("No config file. Run: teamclaw setup");
  }

  // Memory directory
  const memoryDir = path.join(os.homedir(), ".teamclaw", "memory");
  if (existsSync(memoryDir)) {
    lines.push(`  ${pc.green("✓")}  Memory DB    ~/.teamclaw/memory/`);
  } else {
    lines.push(`  ${pc.dim("-")}  Memory DB    ${pc.dim("Not initialized (created on first run)")}`);
  }

  lines.push("");
  lines.push("  Providers:");

  // Provider check
  const manager = getGlobalProviderManager();
  const providers = manager.getProviders();

  if (providers.length === 0) {
    lines.push(`    ${pc.red("✗")}  No providers configured`);
    issues.push("No AI provider configured\n     Fix: Run teamclaw setup\n       Or: export ANTHROPIC_API_KEY=sk-ant-...");
  } else {
    const s = canRenderSpinner ? spinner() : null;
    if (s) s.start(randomPhrase("network"));

    for (const provider of providers) {
      const start = Date.now();
      let ok = false;
      try {
        ok = await provider.healthCheck();
      } catch {
        ok = false;
      }
      const latency = Date.now() - start;

      if (ok) {
        lines.push(`    ${pc.green("✓")}  ${provider.name.padEnd(12)} API key valid ${pc.dim(`(${latency}ms)`)}`);
      } else {
        lines.push(`    ${pc.red("✗")}  ${provider.name.padEnd(12)} ${pc.red("unreachable or invalid key")}`);
        issues.push(`Provider ${provider.name} is not reachable. Check your API key and connection.`);
      }
    }

    if (s) s.stop("Provider check complete.");
  }

  // Summary
  lines.push("");
  lines.push("  " + pc.dim("─".repeat(40)));

  if (issues.length === 0) {
    lines.push(`  ${pc.green("✓")}  Ready to use`);
    lines.push("");
    lines.push(`  Quick start:`);
    lines.push(`    ${pc.cyan('teamclaw work --goal "your goal here"')}`);
  } else {
    lines.push(`  ${pc.red("✗")}  Not ready — ${issues.length} issue(s) found`);
    lines.push("");
    for (const issue of issues) {
      lines.push(`  ${pc.yellow("Issue:")} ${issue}`);
    }
  }

  if (canRenderSpinner) {
    note(lines.join("\n"), "Results");
    outro(issues.length === 0 ? "System check passed." : "System check failed.");
  } else {
    for (const line of lines) {
      logger.plain(line);
    }
  }

  if (issues.length > 0) {
    process.exit(1);
  }
}
