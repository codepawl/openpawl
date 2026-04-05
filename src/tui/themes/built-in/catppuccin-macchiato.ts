import { buildTheme } from "./theme-builder.js";
export const catppuccinMacchiato = buildTheme("catppuccin-macchiato", "Catppuccin Macchiato", "catppuccin", "dark", {
  textPrimary: "#cad3f5", textSecondary: "#a5adcb", textMuted: "#6e738d",
  success: "#a6da95", warning: "#eed49f", error: "#ed8796", info: "#8aadf4", prompt: "#c6a0f6",
  userMessage: "#cad3f5", agentResponse: "#a5adcb", systemMessage: "#6e738d",
  codeInline: "#f5a97f", codeBlockBorder: "#494d64",
  diffAdd: "#a6da95", diffRemove: "#ed8796", diffContext: "#6e738d",
  statusBarBg: "#1e2030", statusBarFg: "#a5adcb", statusBarAccent: "#c6a0f6",
  toolRunning: "#91d7e3", toolCompleted: "#a6da95", toolFailed: "#ed8796", toolBorder: "#494d64",
  link: "#8aadf4", panelBorder: "#363a4f", panelHeader: "#c6a0f6",
  agentCoder: "#c6a0f6", agentReviewer: "#a6da95", agentPlanner: "#8aadf4",
  agentTester: "#f5a97f", agentDebugger: "#f5bde6", agentResearcher: "#eed49f", agentAssistant: "#8087a2",
});
