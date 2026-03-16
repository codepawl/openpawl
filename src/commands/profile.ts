/**
 * CLI command: teamclaw profile <subcommand>
 */

import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { loadTeamConfig } from "../core/team-config.js";
import { VectorMemory } from "../core/knowledge-base.js";
import { GlobalMemoryManager } from "../memory/global/store.js";
import { ProfileStore } from "../agents/profiles/store.js";
import pc from "picocolors";
import { confirm, isCancel } from "@clack/prompts";

async function getProfileStore(): Promise<ProfileStore> {
  const teamConfig = await loadTeamConfig();
  const vm = new VectorMemory(CONFIG.vectorStorePath, teamConfig?.memory_backend ?? CONFIG.memoryBackend);
  await vm.init();
  const embedder = vm.getEmbedder();
  if (!embedder) throw new Error("Embedder not available — is the gateway running?");
  const gm = new GlobalMemoryManager();
  await gm.init(embedder);
  const db = gm.getDb();
  if (!db) throw new Error("Global database not available");
  const store = new ProfileStore();
  await store.init(db);
  return store;
}

export async function runProfileCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "list") {
    try {
      const store = await getProfileStore();
      const profiles = await store.getAll();

      if (profiles.length === 0) {
        logger.plain("No agent profiles found. Run a work session to build profiles.");
        return;
      }

      logger.plain(pc.bold("Agent Performance Profiles"));
      logger.plain("─".repeat(70));
      logger.plain(
        `${"Role".padEnd(25)} ${"Score".padEnd(8)} ${"Tasks".padEnd(8)} ${"Strengths".padEnd(20)} Trend`
      );
      logger.plain("─".repeat(70));

      for (const p of profiles) {
        const score = `${(p.overallScore * 100).toFixed(0)}%`;
        const strengths = p.strengths.length > 0 ? p.strengths.join(", ") : "-";
        const lastScores = p.scoreHistory.slice(-3);
        let trend = "→";
        if (lastScores.length >= 2) {
          const diff = lastScores[lastScores.length - 1] - lastScores[lastScores.length - 2];
          if (diff > 0.02) trend = pc.green("↑");
          else if (diff < -0.02) trend = pc.red("↓");
        }
        logger.plain(
          `${p.agentRole.padEnd(25)} ${score.padEnd(8)} ${String(p.totalTasksCompleted).padEnd(8)} ${strengths.padEnd(20)} ${trend}`
        );
      }
      logger.plain("─".repeat(70));
    } catch (err) {
      logger.error(`Failed to list profiles: ${err}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "show") {
    const role = args[1];
    if (!role) {
      logger.error("Usage: teamclaw profile show <role>");
      process.exit(1);
    }
    try {
      const store = await getProfileStore();
      const profile = await store.getByRole(role);
      if (!profile) {
        logger.error(`No profile found for role: ${role}`);
        process.exit(1);
      }

      logger.plain(pc.bold(`Profile: ${profile.agentRole}`));
      logger.plain(`Overall Score: ${(profile.overallScore * 100).toFixed(1)}%`);
      logger.plain(`Total Tasks: ${profile.totalTasksCompleted}`);
      logger.plain(`Last Updated: ${new Date(profile.lastUpdatedAt).toLocaleString()}`);
      logger.plain(`Strengths: ${profile.strengths.length > 0 ? profile.strengths.join(", ") : "none yet"}`);
      logger.plain(`Weaknesses: ${profile.weaknesses.length > 0 ? profile.weaknesses.join(", ") : "none"}`);

      if (profile.taskTypeScores.length > 0) {
        logger.plain("");
        logger.plain(pc.bold("Per-Task-Type Scores:"));
        logger.plain(`${"Type".padEnd(15)} ${"Success".padEnd(10)} ${"Confidence".padEnd(12)} ${"Rework".padEnd(8)} ${"Count".padEnd(8)} Trend`);
        for (const s of profile.taskTypeScores) {
          logger.plain(
            `${s.taskType.padEnd(15)} ${(s.successRate * 100).toFixed(0).padStart(5)}%    ${(s.averageConfidence * 100).toFixed(0).padStart(5)}%      ${s.averageReworkCount.toFixed(1).padStart(4)}    ${String(s.totalTasksCompleted).padEnd(8)} ${s.trend}`
          );
        }
      }

      if (profile.scoreHistory.length > 0) {
        logger.plain("");
        logger.plain(`Score History (last ${profile.scoreHistory.length}): ${profile.scoreHistory.map((s) => (s * 100).toFixed(0) + "%").join(" → ")}`);
      }
    } catch (err) {
      logger.error(`Failed to show profile: ${err}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "reset") {
    const role = args[1];
    const all = args.includes("--all");

    try {
      const store = await getProfileStore();

      if (all) {
        const ok = await confirm({ message: "Reset ALL agent profiles? This cannot be undone." });
        if (isCancel(ok) || !ok) {
          logger.plain("Cancelled.");
          return;
        }
        const profiles = await store.getAll();
        for (const p of profiles) {
          await store.delete(p.agentRole);
        }
        logger.success(`Deleted ${profiles.length} profile(s).`);
      } else if (role) {
        const ok = await confirm({ message: `Reset profile for ${role}?` });
        if (isCancel(ok) || !ok) {
          logger.plain("Cancelled.");
          return;
        }
        const deleted = await store.delete(role);
        if (deleted) {
          logger.success(`Deleted profile for ${role}.`);
        } else {
          logger.error(`No profile found for role: ${role}`);
        }
      } else {
        logger.error("Usage: teamclaw profile reset <role> | teamclaw profile reset --all");
        process.exit(1);
      }
    } catch (err) {
      logger.error(`Failed to reset profile: ${err}`);
      process.exit(1);
    }
    return;
  }

  logger.error(`Unknown subcommand: profile ${sub}`);
  logger.error("Usage: teamclaw profile [list | show <role> | reset <role> | reset --all]");
  process.exit(1);
}
