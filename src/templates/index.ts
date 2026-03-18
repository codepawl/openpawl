/**
 * Template marketplace barrel export.
 */

export { MarketplaceClient } from "./marketplace-client.js";
export { LocalTemplateStore } from "./local-store.js";
export { validateTemplate, TeamClawTemplateSchema } from "./validator.js";
export type { TemplateValidationResult, ValidatedTemplate } from "./validator.js";
export { TemplatePublisher } from "./publisher.js";
export type {
  TeamClawTemplate,
  InstalledTemplate,
  TemplateAgent,
  TemplateIndex,
  TemplateIndexEntry,
  MarketplaceConfig,
} from "./types.js";
export {
  DEFAULT_MARKETPLACE_CONFIG,
  getMarketplaceBaseUrl,
} from "./types.js";
export {
  getSeedTemplate,
  getAllSeedTemplates,
  isSeedTemplate,
  SEED_TEMPLATE_IDS,
} from "./seeds/index.js";
