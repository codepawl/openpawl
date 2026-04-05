import { buildTheme } from "./theme-builder.js";
export const nord = buildTheme("nord", "Nord", "nordtheme", "dark", {
  textPrimary: "#d8dee9", textSecondary: "#a5abb6", textMuted: "#4c566a",
  success: "#a3be8c", warning: "#ebcb8b", error: "#bf616a", info: "#81a1c1", prompt: "#88c0d0",
  userMessage: "#d8dee9", agentResponse: "#a5abb6", systemMessage: "#4c566a",
  codeInline: "#d08770", codeBlockBorder: "#3b4252",
  diffAdd: "#a3be8c", diffRemove: "#bf616a", diffContext: "#4c566a",
  statusBarBg: "#3b4252", statusBarFg: "#d8dee9", statusBarAccent: "#88c0d0",
  toolRunning: "#88c0d0", toolCompleted: "#a3be8c", toolFailed: "#bf616a", toolBorder: "#3b4252",
  link: "#81a1c1", panelBorder: "#3b4252", panelHeader: "#88c0d0",
  agentCoder: "#88c0d0", agentReviewer: "#a3be8c", agentPlanner: "#81a1c1",
  agentTester: "#d08770", agentDebugger: "#bf616a", agentResearcher: "#ebcb8b", agentAssistant: "#4c566a",
});
