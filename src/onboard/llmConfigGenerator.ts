/**
 * Deprecated in OpenClaw-only mode.
 * Kept only for backwards compatibility with older local workflows.
 */

export interface LlmConfigOptions {
  serviceBaseUrl?: string;
  serviceModel?: string;
  modelName?: string;
}

const DEFAULT_BASE = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3.5:2b";
const DEFAULT_NAME = "team-default";

export function buildLlmConfigYaml(opts: LlmConfigOptions = {}): string {
  const serviceBase = opts.serviceBaseUrl?.trim() || DEFAULT_BASE;
  const serviceModel = opts.serviceModel?.trim() || DEFAULT_MODEL;
  const modelName = opts.modelName?.trim() || DEFAULT_NAME;
  return `# Deprecated TeamClaw helper output.
# TeamClaw runtime does not consume this file in OpenClaw-only mode.
model_list:
  - model_name: ${modelName}
    provider_params:
      model: ${serviceModel}
      api_base: ${serviceBase}
`;
}
