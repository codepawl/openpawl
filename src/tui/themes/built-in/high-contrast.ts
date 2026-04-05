import { buildTheme } from "./theme-builder.js";
export const highContrast = buildTheme("high-contrast", "High Contrast", "openpawl", "dark", {
  textPrimary: "#f0f0f0", textSecondary: "#d0d0d0", textMuted: "#909090",
  success: "#00e060", warning: "#ffd000", error: "#ff3040", info: "#40a0ff", prompt: "#f0f0f0",
  userMessage: "#f0f0f0", agentResponse: "#d0d0d0", systemMessage: "#909090",
  codeInline: "#ffd000", codeBlockBorder: "#404040",
  diffAdd: "#00e060", diffRemove: "#ff3040", diffContext: "#909090",
  statusBarBg: "#1a1a1a", statusBarFg: "#f0f0f0", statusBarAccent: "#40a0ff",
  toolRunning: "#40a0ff", toolCompleted: "#00e060", toolFailed: "#ff3040", toolBorder: "#404040",
  link: "#40a0ff", panelBorder: "#404040", panelHeader: "#f0f0f0",
  agentCoder: "#40a0ff", agentReviewer: "#00e060", agentPlanner: "#d080ff",
  agentTester: "#ffd000", agentDebugger: "#ff3040", agentResearcher: "#00d0d0", agentAssistant: "#909090",
});
