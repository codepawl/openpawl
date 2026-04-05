import { buildTheme } from "./theme-builder.js";
export const gruvboxDark = buildTheme("gruvbox-dark", "Gruvbox Dark", "morhetz", "dark", {
  textPrimary: "#ebdbb2", textSecondary: "#d5c4a1", textMuted: "#928374",
  success: "#b8bb26", warning: "#fabd2f", error: "#fb4934", info: "#83a598", prompt: "#fe8019",
  userMessage: "#ebdbb2", agentResponse: "#d5c4a1", systemMessage: "#928374",
  codeInline: "#fe8019", codeBlockBorder: "#504945",
  diffAdd: "#b8bb26", diffRemove: "#fb4934", diffContext: "#928374",
  statusBarBg: "#3c3836", statusBarFg: "#d5c4a1", statusBarAccent: "#fabd2f",
  toolRunning: "#83a598", toolCompleted: "#b8bb26", toolFailed: "#fb4934", toolBorder: "#504945",
  link: "#83a598", panelBorder: "#504945", panelHeader: "#fe8019",
  agentCoder: "#fe8019", agentReviewer: "#b8bb26", agentPlanner: "#83a598",
  agentTester: "#fabd2f", agentDebugger: "#fb4934", agentResearcher: "#d3869b", agentAssistant: "#928374",
});
