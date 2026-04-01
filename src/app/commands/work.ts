/**
 * /work command — start a work session with a goal.
 * Reuses runWork() from work-runner.ts and wires workerEvents to TUI.
 */
import type { SlashCommand } from "../../tui/index.js";
import type { AppLayout } from "../layout.js";

export function createWorkCommand(layout: AppLayout): SlashCommand {
  return {
    name: "work",
    aliases: ["w"],
    description: "Start a work session with a goal",
    args: "<goal>",
    async execute(args, ctx) {
      const goal = args.trim();
      if (!goal) {
        ctx.addMessage("error", "Usage: /work <goal>");
        return;
      }

      ctx.addMessage("system", `Starting work session: "${goal}"`);

      // Wire workerEvents to route streaming output to Messages
      const { workerEvents } = await import("../../core/worker-events.js");

      let streamingActive = false;
      const onChunk = (data: { botId: string; chunk: string }) => {
        if (!streamingActive) {
          // First chunk — add a new assistant message for streaming
          layout.messages.addMessage({ role: "assistant", content: "", timestamp: new Date() });
          streamingActive = true;
        }
        layout.messages.appendToLast(data.chunk);
        layout.tui.requestRender();
      };

      const onReasoning = (data: { botId: string; reasoning: string }) => {
        const preview = data.reasoning.slice(0, 200).replace(/\n/g, " ");
        layout.messages.addMessage({
          role: "agent",
          agentName: data.botId,
          content: `thinking: ${preview}${data.reasoning.length > 200 ? "..." : ""}`,
          timestamp: new Date(),
        });
        layout.tui.requestRender();
      };

      workerEvents.on("stream-chunk", onChunk);
      workerEvents.on("reasoning", onReasoning);

      try {
        // Use the existing runWork() — reuse ALL orchestration logic
        const { runWork } = await import("../../work-runner.js");
        await runWork({ goal, noWeb: true, args: [] });

        streamingActive = false;
        ctx.addMessage("system", "Work session complete.");
        layout.statusBar.setLeft("TeamClaw", "Done");
      } catch (err) {
        streamingActive = false;
        const msg = err instanceof Error ? err.message : String(err);
        // UserCancelError is normal — don't show as error
        if (err instanceof Error && err.name === "UserCancelError") {
          ctx.addMessage("system", "Work session cancelled.");
        } else {
          ctx.addMessage("error", `Work session failed: ${msg}`);
        }
      } finally {
        workerEvents.off("stream-chunk", onChunk);
        workerEvents.off("reasoning", onReasoning);
        layout.statusBar.setLeft("TeamClaw", "Ready");
        layout.tui.requestRender();
      }
    },
  };
}
