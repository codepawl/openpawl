/**
 * /dev command — toggle dev mode and show diagnostics.
 */
import type { SlashCommand } from "../../tui/index.js";
import { DEV } from "../../dev/index.js";
import { formatBytes } from "../../utils/formatters.js";

export function createDevCommand(): SlashCommand {
  return {
    name: "dev",
    description: "Toggle dev mode (performance overlay + logging)",
    args: "[config|events]",
    async execute(args, ctx) {
      const sub = args.trim().toLowerCase();

      if (sub === "config") {
        const mem = process.memoryUsage();
        ctx.addMessage("system", [
          "Dev Config Dump:",
          `  Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
          `  RSS: ${formatBytes(mem.rss)}`,
          `  Dev mode: ${DEV.enabled ? "ON" : "OFF"}`,
          `  PID: ${process.pid}`,
          `  Uptime: ${(process.uptime() / 60).toFixed(1)}min`,
          `  Node: ${process.version}`,
          `  CWD: ${process.cwd()}`,
        ].join("\n"));
        return;
      }

      if (sub === "perf") {
        if (!DEV.enabled) {
          ctx.addMessage("system", "Dev mode is off. Run /dev to enable first.");
          return;
        }
        const stats = DEV.getOverlayLines().join("\n");
        ctx.addMessage("system", stats);
        return;
      }

      // Toggle dev mode
      const nowEnabled = DEV.toggle();
      ctx.addMessage("system", nowEnabled
        ? "Dev mode ON. Slow frames (>10ms) logged to ~/.openpawl/logs/perf.log"
        : "Dev mode OFF.");
    },
  };
}
