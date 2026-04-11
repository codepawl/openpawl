/**
 * OpenPawl check — comprehensive system check with actionable output.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { intro, note, outro, spinner } from "@clack/prompts";
import pc from "picocolors";
import { ICONS } from "./tui/constants/icons.js";

import { logger } from "./core/logger.js";
import { getGlobalProviderManager } from "./providers/provider-factory.js";
import { randomPhrase } from "./utils/spinner-phrases.js";

export async function runCheck(_args: string[]): Promise<void> {
  const canRenderSpinner = Boolean(process.stdout.isTTY && process.stderr.isTTY);

  if (canRenderSpinner) {
    intro("OpenPawl System Check");
  } else {
    logger.plain("OpenPawl System Check\n");
  }

  const issues: string[] = [];
  const lines: string[] = [];

  // Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  if (nodeMajor >= 20) {
    lines.push(`  ${pc.green(ICONS.success)}  Node.js      ${nodeVersion} ${pc.dim("(required: >=20)")}`);
  } else {
    lines.push(`  ${pc.red(ICONS.error)}  Node.js      ${nodeVersion} ${pc.red("(required: >=20)")}`);
    issues.push("Node.js version must be >= 20");
  }

  // Config file
  const configPath = path.join(os.homedir(), ".openpawl", "config.json");
  if (existsSync(configPath)) {
    try {
      const { readFileSync } = await import("node:fs");
      const { validateConfig } = await import("./core/config-validator.js");
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const result = validateConfig(raw);
      if (result.success) {
        const providerCount = result.data.providers?.length ?? 0;
        lines.push(`  ${pc.green(ICONS.success)}  Config       ~/.openpawl/config.json ${pc.dim(`(${providerCount} provider${providerCount !== 1 ? "s" : ""})`)}`);

        // Show new config sections
        const d = result.data.dashboard;
        const dashPort = d?.port ?? result.data.dashboardPort ?? 9001;
        const dashPersist = d?.persistent !== false;
        const dashAutoOpen = d?.autoOpen === true;
        lines.push(`  ${pc.green(ICONS.success)}  Dashboard    port ${dashPort}, ${dashPersist ? "persistent" : "session-scoped"}${dashAutoOpen ? ", auto-open" : ""}`);

        const w = result.data.work;
        const workInteractive = w?.interactive !== false;
        lines.push(`  ${pc.green(ICONS.success)}  Work         interactive ${workInteractive ? "on" : "off"}`);

        const t = result.data.timeouts;
        const firstChunk = t?.firstChunkMs ?? 15000;
        const requestMs = t?.requestMs ?? 60000;
        lines.push(`  ${pc.green(ICONS.success)}  Timeouts     firstChunk: ${(firstChunk / 1000).toFixed(0)}s, request: ${(requestMs / 1000).toFixed(0)}s`);
      } else {
        lines.push(`  ${pc.yellow(ICONS.warning)}  Config       ~/.openpawl/config.json ${pc.yellow("(validation warnings)")}`);
        for (const err of result.errors.slice(0, 3)) {
          lines.push(`    ${pc.dim("  " + err)}`);
        }
      }
    } catch {
      lines.push(`  ${pc.yellow(ICONS.warning)}  Config       ~/.openpawl/config.json ${pc.yellow("(could not parse)")}`);
    }
  } else {
    lines.push(`  ${pc.red(ICONS.error)}  Config       ${pc.dim("Not found")}`);
    issues.push("No config file. Run: openpawl setup");
  }

  // Memory directory
  const memoryDir = path.join(os.homedir(), ".openpawl", "memory");
  if (existsSync(memoryDir)) {
    lines.push(`  ${pc.green(ICONS.success)}  Memory DB    ~/.openpawl/memory/`);
  } else {
    lines.push(`  ${pc.dim("-")}  Memory DB    ${pc.dim("Not initialized (created on first run)")}`);
  }

  lines.push("");
  lines.push("  Providers:");

  // Provider check
  const manager = await getGlobalProviderManager();
  const providers = manager.getProviders();

  if (providers.length === 0) {
    lines.push(`    ${pc.red(ICONS.error)}  No providers configured`);
    issues.push("No AI provider configured\n     Fix: Run openpawl setup\n       Or: export ANTHROPIC_API_KEY=sk-ant-...");
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
        lines.push(`    ${pc.green(ICONS.success)}  ${provider.name.padEnd(12)} API key valid ${pc.dim(`(${latency}ms)`)}`);
      } else {
        lines.push(`    ${pc.red(ICONS.error)}  ${provider.name.padEnd(12)} ${pc.red("unreachable or invalid key")}`);
        issues.push(`Provider ${provider.name} is not reachable. Check your API key and connection.`);
      }
    }

    if (s) s.stop("Provider check complete.");
  }

  // Sandbox check
  lines.push("");
  lines.push("  Sandbox:");
  try {
    const {
      NodeRuntime,
      createNodeDriver,
      createNodeRuntimeDriverFactory,
    } = await import("secure-exec");

    const runtime = new NodeRuntime({
      systemDriver: createNodeDriver(),
      runtimeDriverFactory: createNodeRuntimeDriverFactory(),
      memoryLimit: 32,
      cpuTimeLimitMs: 1000,
    });

    const result = await runtime.run<number>("module.exports = 21 * 2;");
    runtime.dispose();

    if (result.exports === 42) {
      lines.push(`    ${pc.green(ICONS.success)}  V8 isolate   ${pc.dim("secure-exec ready")}`);
    } else {
      lines.push(`    ${pc.yellow(ICONS.warning)}  V8 isolate   ${pc.dim("unexpected result")}`);
      issues.push("Sandbox V8 isolate returned unexpected result");
    }
  } catch (err) {
    lines.push(`    ${pc.red(ICONS.error)}  V8 isolate   ${pc.red("unavailable")}`);
    issues.push("Sandbox V8 isolate unavailable. Run: bun install secure-exec");
    if (err instanceof Error) {
      lines.push(`    ${pc.dim("              " + err.message)}`);
    }
  }

  // Langfuse
  lines.push("");
  lines.push("  Observability:");
  const hasLangfuse = !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
  if (hasLangfuse) {
    lines.push(`    ${pc.green(ICONS.success)}  Langfuse     ${pc.dim("Tracing active")}`);
  } else {
    lines.push(`    ${pc.dim("-")}  Langfuse     ${pc.dim("Not configured (optional)")}`);
    lines.push(`    ${pc.dim("              Set LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY to enable")}`);
  }

  // Summary
  lines.push("");
  lines.push("  " + pc.dim("─".repeat(40)));

  if (issues.length === 0) {
    lines.push(`  ${pc.green(ICONS.success)}  Ready to use`);
    lines.push("");
    lines.push(`  Quick start:`);
    lines.push(`    ${pc.cyan('openpawl work --goal "your goal here"')}`);
  } else {
    lines.push(`  ${pc.red(ICONS.error)}  Not ready — ${issues.length} issue(s) found`);
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
