/**
 * Template marketplace types.
 */

export interface TemplateAgent {
  role: string;
  model?: string;
  systemPromptOverride?: string;
  taskTypes?: string[];
  compositionRules?: {
    required?: boolean;
    includeKeywords?: string[];
  };
}

export interface TeamClawTemplate {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  tags: string[];
  agents: TemplateAgent[];
  defaultGoalTemplate?: string;
  estimatedCostPerRun?: number;
  minRuns?: number;
  requiresWebhook?: boolean;
  readme?: string;
}

export interface InstalledTemplate extends TeamClawTemplate {
  installedAt: number;
  installedVersion: string;
}

export interface TemplateIndexEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  estimatedCostPerRun?: number;
  stars: number;
  downloads: number;
  createdAt: string;
  path: string;
  updatedAt?: string;
}

export interface TemplateIndex {
  version: string;
  updatedAt: string;
  templates: TemplateIndexEntry[];
}

export interface MarketplaceConfig {
  baseUrl: string;
  repo: string;
  timeout: number;
  cacheTtlMs: number;
}

export const DEFAULT_MARKETPLACE_CONFIG: MarketplaceConfig = {
  baseUrl: "https://raw.githubusercontent.com/nxank4/teamclaw-templates/main",
  repo: "nxank4/teamclaw-templates",
  timeout: 5_000,
  cacheTtlMs: 60 * 60 * 1000, // 1 hour
};

export function getMarketplaceBaseUrl(): string {
  return DEFAULT_MARKETPLACE_CONFIG.baseUrl;
}
