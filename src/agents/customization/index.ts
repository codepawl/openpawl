/**
 * Agent customization engine — define, modify, share agents via YAML.
 */

// Types
export type {
  AgentYaml,
  AgentSource,
  ResolvedAgent,
  ResolvedPersonality,
  AgentCustomizationError,
  ValidationIssue,
  AgentDirectory,
} from "./types.js";

export { AgentYamlSchema } from "./types.js";

// Core
export { AgentYamlLoader } from "./yaml-loader.js";
export type { LoadResult } from "./yaml-loader.js";
export { InheritanceResolver } from "./inheritance.js";
export { AgentPromptBuilder } from "./prompt-builder.js";
export { AgentValidator } from "./validator.js";
export { AgentHotReloader } from "./hot-reload.js";
export type { ReloadResult } from "./hot-reload.js";
export { AgentExporter } from "./exporter.js";
export { CommunityAgentLoader } from "./community-loader.js";
export type { CommunityAgent } from "./community-loader.js";
