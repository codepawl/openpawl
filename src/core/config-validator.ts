import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const OpenPawlConfigSchema = z.object({
  // Legacy top-level version (kept for backward compat; prefer meta.version)
  version: z.union([z.literal(1), z.string()]).optional(),

  meta: z.object({
    version: z.string().default("1"),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    setupVersion: z.string().optional(),
  }).optional(),

  activeProvider: z.string().optional(),
  activeModel: z.string().optional(),
  /** @deprecated Use activeModel instead. Kept for backward compatibility. */
  model: z.string().optional(),

  dashboardPort: z.number().int().positive().default(9001),
  debugMode: z.boolean().default(false),

  providers: z.array(z.object({
    type: z.string(),
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string().optional(),
    name: z.string().optional(),
    authMethod: z.enum(["apikey", "oauth", "device-oauth", "local", "credentials"]).optional(),
  }).passthrough()).optional(),

  agentModels: z.record(z.string()).optional(),
  modelAliases: z.record(z.string()).optional(),
  fallbackChain: z.array(z.string()).optional(),

  agents: z.record(z.object({
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    tier: z.enum(["primary", "fast", "mini"]).optional(),
    systemPromptAppend: z.string().optional(),
  })).optional(),

  timeouts: z.object({
    firstChunkMs: z.number().int().positive().default(15000),
    requestMs: z.number().int().positive().default(60000),
  }).optional(),

  tokenOptimization: z.object({
    promptCaching: z.boolean().optional(),
    modelRouting: z.object({
      enabled: z.boolean().optional(),
    }).passthrough().optional(),
    semanticCache: z.object({
      enabled: z.boolean().optional(),
      similarityThreshold: z.number().optional(),
      ttlMinutes: z.number().optional(),
    }).optional(),
    payloadCompression: z.object({
      enabled: z.boolean().optional(),
      thresholdChars: z.number().optional(),
    }).optional(),
    memoryTopK: z.number().int().positive().optional(),
  }).passthrough().optional(),

  dashboard: z.object({
    port: z.number().int().min(1024).max(65535).default(9001),
    persistent: z.boolean().default(true),
    autoOpen: z.boolean().default(false),
  }).optional(),

  work: z.object({
    interactive: z.boolean().default(true),
    sessionCount: z.number().int().nonnegative().default(0),
  }).optional(),

  streaming: z.object({
    enabled: z.boolean().default(true),
    showThinking: z.boolean().default(false),
  }).optional(),

  confidenceScoring: z.object({
    enabled: z.boolean().optional(),
    thresholds: z.object({
      autoApprove: z.number().optional(),
      reviewRequired: z.number().optional(),
      reworkRequired: z.number().optional(),
    }).optional(),
  }).optional(),
  handoff: z.object({
    autoGenerate: z.boolean().optional(),
    outputPath: z.string().optional(),
    keepHistory: z.boolean().optional(),
    gitCommit: z.boolean().optional(),
  }).optional(),
  personality: z.object({
    enabled: z.boolean().optional(),
    pushbackEnabled: z.boolean().optional(),
    coordinatorIntervention: z.boolean().optional(),
  }).optional(),
  workspaceDir: z.string().optional(),
}).passthrough(); // allow extra fields we haven't schematized

export type ValidatedConfig = z.infer<typeof OpenPawlConfigSchema>;

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Migrate legacy config shapes before validation.
 * - providers.firstChunkTimeoutMs → timeouts.firstChunkMs (field was removed but may exist in old configs)
 * - top-level version → meta.version
 */
export function migrateConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const config = { ...raw } as Record<string, unknown>;

  // Migrate providers.firstChunkTimeoutMs → timeouts.firstChunkMs
  const providers = config.providers;
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    const provObj = providers as Record<string, unknown>;
    if (typeof provObj.firstChunkTimeoutMs === "number") {
      const existing = (config.timeouts ?? {}) as Record<string, unknown>;
      config.timeouts = {
        firstChunkMs: provObj.firstChunkTimeoutMs,
        ...existing,
      };
      delete provObj.firstChunkTimeoutMs;
    }
  }

  // Migrate top-level version → meta.version
  if (config.version != null && !config.meta) {
    config.meta = { version: String(config.version) };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateConfig(raw: unknown): { success: true; data: ValidatedConfig } | { success: false; errors: string[] } {
  const migrated = migrateConfig(raw);
  const result = OpenPawlConfigSchema.safeParse(migrated);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map(issue => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { success: false, errors };
}
