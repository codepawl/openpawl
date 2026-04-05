import { buildTheme } from "./theme-builder.js";
export const catppuccinFrappe = buildTheme("catppuccin-frappe", "Catppuccin Frappé", "catppuccin", "dark", {
  textPrimary: "#c6d0f5", textSecondary: "#a5adce", textMuted: "#737994",
  success: "#a6d189", warning: "#e5c890", error: "#e78284", info: "#8caaee", prompt: "#ca9ee6",
  userMessage: "#c6d0f5", agentResponse: "#a5adce", systemMessage: "#737994",
  codeInline: "#ef9f76", codeBlockBorder: "#51576d",
  diffAdd: "#a6d189", diffRemove: "#e78284", diffContext: "#737994",
  statusBarBg: "#292c3c", statusBarFg: "#a5adce", statusBarAccent: "#ca9ee6",
  toolRunning: "#99d1db", toolCompleted: "#a6d189", toolFailed: "#e78284", toolBorder: "#51576d",
  link: "#8caaee", panelBorder: "#414559", panelHeader: "#ca9ee6",
  agentCoder: "#ca9ee6", agentReviewer: "#a6d189", agentPlanner: "#8caaee",
  agentTester: "#ef9f76", agentDebugger: "#f4b8e4", agentResearcher: "#e5c890", agentAssistant: "#838ba7",
});
