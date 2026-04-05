import { buildTheme } from "./theme-builder.js";
export const rosePine = buildTheme("rose-pine", "Rosé Pine", "rose-pine", "dark", {
  textPrimary: "#e0def4", textSecondary: "#908caa", textMuted: "#6e6a86",
  success: "#9ccfd8", warning: "#f6c177", error: "#eb6f92", info: "#31748f", prompt: "#c4a7e7",
  userMessage: "#e0def4", agentResponse: "#908caa", systemMessage: "#6e6a86",
  codeInline: "#ebbcba", codeBlockBorder: "#26233a",
  diffAdd: "#9ccfd8", diffRemove: "#eb6f92", diffContext: "#6e6a86",
  statusBarBg: "#1f1d2e", statusBarFg: "#908caa", statusBarAccent: "#c4a7e7",
  toolRunning: "#9ccfd8", toolCompleted: "#9ccfd8", toolFailed: "#eb6f92", toolBorder: "#26233a",
  link: "#31748f", panelBorder: "#26233a", panelHeader: "#c4a7e7",
  agentCoder: "#c4a7e7", agentReviewer: "#9ccfd8", agentPlanner: "#31748f",
  agentTester: "#f6c177", agentDebugger: "#eb6f92", agentResearcher: "#ebbcba", agentAssistant: "#6e6a86",
});
