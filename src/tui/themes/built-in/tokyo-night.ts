import { buildTheme } from "./theme-builder.js";
export const tokyoNight = buildTheme("tokyo-night", "Tokyo Night", "folke", "dark", {
  textPrimary: "#c0caf5", textSecondary: "#a9b1d6", textMuted: "#565f89",
  success: "#9ece6a", warning: "#e0af68", error: "#f7768e", info: "#7aa2f7", prompt: "#bb9af7",
  userMessage: "#c0caf5", agentResponse: "#a9b1d6", systemMessage: "#565f89",
  codeInline: "#ff9e64", codeBlockBorder: "#292e42",
  diffAdd: "#9ece6a", diffRemove: "#f7768e", diffContext: "#565f89",
  statusBarBg: "#16161e", statusBarFg: "#a9b1d6", statusBarAccent: "#bb9af7",
  toolRunning: "#7dcfff", toolCompleted: "#9ece6a", toolFailed: "#f7768e", toolBorder: "#292e42",
  link: "#7aa2f7", panelBorder: "#292e42", panelHeader: "#bb9af7",
  agentCoder: "#bb9af7", agentReviewer: "#9ece6a", agentPlanner: "#7aa2f7",
  agentTester: "#ff9e64", agentDebugger: "#f7768e", agentResearcher: "#e0af68", agentAssistant: "#565f89",
});
