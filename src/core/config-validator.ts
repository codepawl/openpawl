import { z } from "zod";

export const TeamClawConfigSchema = z.object({
  version: z.union([z.literal(1), z.string()]).default("1"),
  dashboardPort: z.number().int().positive().default(9001),
  debugMode: z.boolean().default(false),
  providers: z.array(z.object({
    type: z.string(),
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string().optional(),
    name: z.string().optional(),
    authMethod: z.enum(["apikey", "oauth", "device-oauth", "setup-token", "local", "credentials"]).optional(),
  }).passthrough()).optional(),
  agentModels: z.record(z.string()).optional(),
  modelAliases: z.record(z.string()).optional(),
  fallbackChain: z.array(z.string()).optional(),
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

export type ValidatedConfig = z.infer<typeof TeamClawConfigSchema>;

export function validateConfig(raw: unknown): { success: true; data: ValidatedConfig } | { success: false; errors: string[] } {
  const result = TeamClawConfigSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map(issue => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { success: false, errors };
}
