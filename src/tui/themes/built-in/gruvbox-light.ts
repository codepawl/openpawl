import { buildTheme } from "./theme-builder.js";
export const gruvboxLight = buildTheme("gruvbox-light", "Gruvbox Light", "morhetz", "light", {
  textPrimary: "#3c3836", textSecondary: "#504945", textMuted: "#928374",
  success: "#79740e", warning: "#b57614", error: "#9d0006", info: "#076678", prompt: "#af3a03",
  userMessage: "#3c3836", agentResponse: "#504945", systemMessage: "#928374",
  codeInline: "#af3a03", codeBlockBorder: "#d5c4a1",
  diffAdd: "#79740e", diffRemove: "#9d0006", diffContext: "#928374",
  statusBarBg: "#ebdbb2", statusBarFg: "#504945", statusBarAccent: "#b57614",
  toolRunning: "#076678", toolCompleted: "#79740e", toolFailed: "#9d0006", toolBorder: "#d5c4a1",
  link: "#076678", panelBorder: "#d5c4a1", panelHeader: "#af3a03",
  agentCoder: "#af3a03", agentReviewer: "#79740e", agentPlanner: "#076678",
  agentTester: "#b57614", agentDebugger: "#9d0006", agentResearcher: "#8f3f71", agentAssistant: "#928374",
});
