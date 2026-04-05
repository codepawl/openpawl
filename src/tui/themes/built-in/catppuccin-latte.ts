import { buildTheme } from "./theme-builder.js";
export const catppuccinLatte = buildTheme("catppuccin-latte", "Catppuccin Latte", "catppuccin", "light", {
  textPrimary: "#4c4f69", textSecondary: "#5c5f77", textMuted: "#9ca0b0",
  success: "#40a02b", warning: "#df8e1d", error: "#d20f39", info: "#1e66f5", prompt: "#8839ef",
  userMessage: "#4c4f69", agentResponse: "#5c5f77", systemMessage: "#8c8fa1",
  codeInline: "#fe640b", codeBlockBorder: "#ccd0da",
  diffAdd: "#40a02b", diffRemove: "#d20f39", diffContext: "#8c8fa1",
  statusBarBg: "#e6e9ef", statusBarFg: "#5c5f77", statusBarAccent: "#8839ef",
  toolRunning: "#04a5e5", toolCompleted: "#40a02b", toolFailed: "#d20f39", toolBorder: "#ccd0da",
  link: "#1e66f5", panelBorder: "#ccd0da", panelHeader: "#8839ef",
  agentCoder: "#8839ef", agentReviewer: "#40a02b", agentPlanner: "#1e66f5",
  agentTester: "#fe640b", agentDebugger: "#ea76cb", agentResearcher: "#df8e1d", agentAssistant: "#7c7f93",
});
