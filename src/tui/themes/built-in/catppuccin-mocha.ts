import { buildTheme } from "./theme-builder.js";
export const catppuccinMocha = buildTheme("catppuccin-mocha", "Catppuccin Mocha", "catppuccin", "dark", {
  textPrimary: "#cdd6f4", textSecondary: "#bac2de", textMuted: "#6c7086",
  success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8", info: "#89b4fa", prompt: "#cba6f7",
  userMessage: "#cdd6f4", agentResponse: "#bac2de", systemMessage: "#7f849c",
  codeInline: "#fab387", codeBlockBorder: "#45475a",
  diffAdd: "#a6e3a1", diffRemove: "#f38ba8", diffContext: "#7f849c",
  statusBarBg: "#181825", statusBarFg: "#bac2de", statusBarAccent: "#cba6f7",
  toolRunning: "#89dceb", toolCompleted: "#a6e3a1", toolFailed: "#f38ba8", toolBorder: "#45475a",
  link: "#89b4fa", panelBorder: "#313244", panelHeader: "#cba6f7",
  agentCoder: "#cba6f7", agentReviewer: "#a6e3a1", agentPlanner: "#89b4fa",
  agentTester: "#fab387", agentDebugger: "#f5c2e7", agentResearcher: "#f9e2af", agentAssistant: "#9399b2",
});
