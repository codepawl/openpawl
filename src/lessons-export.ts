/**
 * Export lessons from VectorMemory to Markdown (SOP document).
 */

import { VectorMemory } from "./core/knowledge-base.js";
import { CONFIG } from "./core/config.js";
import { logger } from "./core/logger.js";
import { loadTeamConfig } from "./core/team-config.js";

export async function runLessonsExport(args: string[]): Promise<void> {
  const format = args.includes("--format") && args[args.indexOf("--format") + 1]
    ? args[args.indexOf("--format") + 1]
    : "markdown";

  const teamConfig = await loadTeamConfig();
  const vectorMemory = new VectorMemory(
    CONFIG.vectorStorePath,
    teamConfig?.memory_backend ?? CONFIG.memoryBackend
  );
  await vectorMemory.init();

  const lessons = await vectorMemory.getCumulativeLessons();

  if (format === "markdown") {
    const md = [
      "# TeamClaw — Standard Operating Procedures",
      "",
      "Lessons learned from prior work sessions. Use these to improve future runs.",
      "",
      "## Lessons",
      "",
      ...lessons.map((l, i) => `${i + 1}. ${l}`),
      "",
      "---",
      `*Exported ${new Date().toISOString()} | ${lessons.length} lessons*`,
    ].join("\n");
    logger.plain(md);
  } else {
    logger.plain(JSON.stringify(lessons, null, 2));
  }
}
