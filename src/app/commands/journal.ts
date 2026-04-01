/**
 * /journal command — search or list past decisions.
 */
import type { SlashCommand } from "../../tui/index.js";

export function createJournalCommand(): SlashCommand {
  return {
    name: "journal",
    aliases: ["j"],
    description: "Search or list past decisions",
    args: "[search query]",
    async execute(args, ctx) {
      try {
        const { VectorMemory } = await import("../../core/knowledge-base.js");
        const { CONFIG } = await import("../../core/config.js");
        const { DecisionStore } = await import("../../journal/store.js");
        const { GlobalMemoryManager } = await import("../../memory/global/store.js");

        const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
        await vm.init();
        const embedder = vm.getEmbedder();
        if (!embedder) { ctx.addMessage("error", "Memory backend unavailable. Run `teamclaw setup`."); return; }

        const gmm = new GlobalMemoryManager();
        await gmm.init(embedder);
        const db = gmm.getDb();
        if (!db) { ctx.addMessage("error", "Global database unavailable."); return; }

        const store = new DecisionStore();
        await store.init(db);

        if (args.trim()) {
          const results = await store.searchDecisions(args.trim());
          if (results.length === 0) {
            ctx.addMessage("system", `No decisions found matching "${args.trim()}".`);
            return;
          }
          const lines = results.slice(0, 10).map((d) => {
            const date = new Date(d.capturedAt).toISOString().slice(0, 10);
            return `[${date}] **${d.decision}** (${d.recommendedBy}, ${(d.confidence * 100).toFixed(0)}%)`;
          });
          ctx.addMessage("system", `${results.length} decision(s) found:\n\n${lines.join("\n")}`);
        } else {
          const all = await store.getRecentDecisions(14);
          if (all.length === 0) {
            ctx.addMessage("system", "No decisions in the journal. Run a work session to build history.");
            return;
          }
          const lines = all.slice(0, 15).map((d) => {
            const date = new Date(d.capturedAt).toISOString().slice(0, 10);
            return `[${date}] **${d.decision}** (${d.recommendedBy})`;
          });
          ctx.addMessage("system", `Recent decisions:\n\n${lines.join("\n")}`);
        }
      } catch (err) {
        ctx.addMessage("error", `Journal error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
