/**
 * Prompt routing handlers — dispatch user messages to PromptRouter or fallback LLM.
 */

import { getAgentColorFn, agentDisplayName } from "./agent-display.js";
import { ICONS } from "../tui/constants/icons.js";
import { defaultTheme } from "../tui/themes/default.js";
import { getConnectionState, setConnectionState } from "../core/connection-state.js";
import type { AppLayout } from "./layout.js";
import type { Session } from "../session/session.js";
import type { PromptRouter } from "../router/prompt-router.js";
import type { AppModeSystem } from "../tui/keybindings/app-mode.js";

export async function handleWithRouter(
  text: string,
  session: Session,
  router: PromptRouter,
  layout: AppLayout,
  ctx: { addMessage: (role: string, content: string) => void },
  appModeSystem?: AppModeSystem | null,
): Promise<void> {
  try {
    const { ClarificationDetector } = await import("../conversation/clarification.js");
    const detector = new ClarificationDetector();
    const clarification = detector.detect(text, {});
    if (clarification?.severity === "ask") {
      ctx.addMessage("system", defaultTheme.warning(`\u2753 ${clarification.questions[0]}`));
      layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
      layout.tui.requestRender();
      return;
    }
  } catch {
    // Clarification module not available — proceed without it
  }

  layout.statusBar.updateSegment(3, "routing...", defaultTheme.accent);
  layout.tui.requestRender();

  const result = await router.route(session.id, text, {
    appMode: appModeSystem?.getMode(),
  });

  if (result.isErr()) {
    if ("cause" in result.error && result.error.cause?.includes("aborted")) return;
    ctx.addMessage("error", `Error: ${result.error.type}`);
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
    layout.tui.requestRender();
    return;
  }

  const dispatch = result.value;

  for (const agentResult of dispatch.agentResults) {
    if (!agentResult.response) continue;

    if (agentResult.agentId === "system") {
      ctx.addMessage("system", agentResult.response);
    } else if (agentResult.inputTokens === 0 && agentResult.outputTokens === 0) {
      layout.messages.addMessage({
        role: "agent",
        agentName: agentDisplayName(agentResult.agentId),
        agentColor: getAgentColorFn(agentResult.agentId),
        content: agentResult.response,
        timestamp: new Date(),
      });
      layout.tui.requestRender();
    }
  }

  layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
  layout.tui.requestRender();
}

export async function handleChatFallback(
  text: string,
  layout: AppLayout,
  ctx: { addMessage: (role: string, content: string) => void },
): Promise<void> {
  layout.statusBar.updateSegment(3, "thinking...", defaultTheme.accent);
  layout.tui.requestRender();

  try {
    const { callLLM } = await import("../engine/llm.js");
    layout.messages.addMessage({ role: "assistant", content: "", timestamp: new Date() });

    const { buildIdentityPrefix } = await import("../router/agent-registry.js");
    await callLLM(text, {
      systemPrompt: buildIdentityPrefix("Assistant") +
        "\n\nYou are running in a terminal. Use markdown formatting when helpful.",
      onChunk: (chunk: string) => {
        layout.messages.appendToLast(chunk);
        layout.tui.requestRender();
      },
    });
  } catch (err) {
    const { translateError } = await import("../engine/errors.js");
    const { setLastError } = await import("./commands/error.js");
    const opError = translateError(err);
    setLastError(opError);

    const connState = getConnectionState();
    if (opError.code === "AUTH_FAILED") {
      setConnectionState({ ...connState, status: "auth_failed" }, { force: true });
    } else if (opError.code === "NETWORK_ERROR") {
      setConnectionState({ ...connState, status: "offline" }, { force: true });
    } else if (opError.code !== "RATE_LIMITED" && opError.code !== "CONTEXT_LENGTH_EXCEEDED") {
      setConnectionState({ ...connState, status: "error" }, { force: true });
    }

    const lines: string[] = [`${ICONS.error} ${opError.userMessage}`];
    if (opError.quickFixes.length > 0) {
      lines.push("");
      for (const fix of opError.quickFixes) {
        if (fix.command) lines.push(`  ${fix.command.padEnd(35)} ${fix.description}`);
        else lines.push(`  ${ICONS.bullet} ${fix.description}`);
      }
    }
    lines.push("");
    lines.push("  Type /error for technical details");
    ctx.addMessage("error", lines.join("\n"));
  } finally {
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
    layout.tui.requestRender();
  }
}
