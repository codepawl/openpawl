import { logger } from "../core/logger.js";
import pc from "picocolors";

export async function runProvidersCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    logger.plain("Usage: teamclaw providers <subcommand>");
    logger.plain("");
    logger.plain("Subcommands:");
    logger.plain("  list     Show configured providers and status");
    logger.plain("  test     Test each provider in chain");
    return;
  }

  if (sub === "list") {
    const { readGlobalConfig } = await import("../core/global-config.js");
    const cfg = readGlobalConfig();
    const providers = (cfg as Record<string, unknown> | null)?.providers as Record<string, unknown> | undefined;
    const anthropicCfg = providers?.anthropic as Record<string, unknown> | undefined;
    const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY || anthropicCfg?.apiKey);

    logger.plain("Providers:");
    logger.plain(`  1. ${pc.bold("OpenClaw gateway")}     ${pc.green("configured")} (primary)`);
    if (hasAnthropicKey) {
      logger.plain(`  2. ${pc.bold("Anthropic API")}        ${pc.green("configured")} (fallback)`);
    } else {
      logger.plain(`  2. ${pc.bold("Anthropic API")}        ${pc.dim("not configured")} (fallback)`);
    }
    return;
  }

  if (sub === "test") {
    const { readGlobalConfigWithDefaults } = await import("../core/global-config.js");
    const cfg = readGlobalConfigWithDefaults();
    const providers = (cfg as unknown as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
    const anthropicCfg = providers?.anthropic as Record<string, unknown> | undefined;

    logger.plain("Checking providers...");

    const openclawUrl = cfg.apiUrl || `http://${cfg.gatewayHost}:${cfg.apiPort}`;
    const start = Date.now();
    try {
      const res = await fetch(`${openclawUrl}/health`, { method: "GET", signal: AbortSignal.timeout(5000) });
      const elapsed = Date.now() - start;
      if (res.ok) {
        logger.plain(`  ${pc.green("✓")} OpenClaw gateway     connected (${elapsed}ms)`);
      } else {
        logger.plain(`  ${pc.red("✗")} OpenClaw gateway     HTTP ${res.status}`);
      }
    } catch {
      logger.plain(`  ${pc.red("✗")} OpenClaw gateway     unreachable`);
    }

    const hasKey = !!(process.env.ANTHROPIC_API_KEY || anthropicCfg?.apiKey);
    if (hasKey) {
      logger.plain(`  ${pc.green("✓")} Anthropic API        configured (key present)`);
    } else {
      logger.plain(`  ${pc.dim("-")} Anthropic API        not configured`);
    }

    logger.plain(`Primary: OpenClaw`);
    if (hasKey) logger.plain(`Fallback: Anthropic`);
    return;
  }

  logger.error(`Unknown providers subcommand: ${sub}`);
  logger.error("Run `teamclaw providers --help` for usage.");
  process.exit(1);
}
