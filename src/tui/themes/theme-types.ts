/**
 * Extended theme types for the developer-friendly theme system.
 * Extends the base Theme interface with semantic color roles.
 */
import type { Theme } from "./theme.js";

export interface ThemeDefinition {
  id: string;
  name: string;
  author: string;
  variant: "dark" | "light";
  palette: ThemePalette;
  theme: Theme;
}

export interface ThemePalette {
  // Core
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  // Semantic
  success: string;
  warning: string;
  error: string;
  info: string;
  prompt: string;
  // Chat
  userMessage: string;
  agentResponse: string;
  systemMessage: string;
  // Code
  codeInline: string;
  codeBlockBorder: string;
  // Diff
  diffAdd: string;
  diffRemove: string;
  diffContext: string;
  // Status bar
  statusBarBg: string;
  statusBarFg: string;
  statusBarAccent: string;
  // Tools
  toolRunning: string;
  toolCompleted: string;
  toolFailed: string;
  toolBorder: string;
  // UI
  link: string;
  panelBorder: string;
  panelHeader: string;
  // Agent colors
  agentCoder: string;
  agentReviewer: string;
  agentPlanner: string;
  agentTester: string;
  agentDebugger: string;
  agentResearcher: string;
  agentAssistant: string;
}
