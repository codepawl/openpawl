import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    // Provider API keys — all optional
    ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-").optional(),
    OPENAI_API_KEY: z.string().startsWith("sk-").optional(),
    XAI_API_KEY: z.string().startsWith("xai-").optional(),
    GOOGLE_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    MISTRAL_API_KEY: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    GROQ_API_KEY: z.string().startsWith("gsk_").optional(),
    CEREBRAS_API_KEY: z.string().optional(),
    TOGETHER_API_KEY: z.string().optional(),
    FIREWORKS_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().startsWith("sk-or-").optional(),
    PERPLEXITY_API_KEY: z.string().optional(),
    MOONSHOT_API_KEY: z.string().optional(),
    ZAI_API_KEY: z.string().optional(),
    MINIMAX_API_KEY: z.string().optional(),
    COHERE_API_KEY: z.string().optional(),
    OPENCODE_API_KEY: z.string().optional(),

    // AWS Bedrock
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().default("us-east-1"),

    // Google Vertex
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
    GOOGLE_CLOUD_PROJECT: z.string().optional(),

    // Observability
    LANGFUSE_SECRET_KEY: z.string().startsWith("sk-lf-").optional(),
    LANGFUSE_PUBLIC_KEY: z.string().startsWith("pk-lf-").optional(),
    LANGFUSE_BASE_URL: z.string().url().optional(),

    // TeamClaw settings
    TEAMCLAW_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    TEAMCLAW_CONFIG_DIR: z.string().optional(),
    TEAMCLAW_PORT: z.coerce.number().int().positive().optional(),
    TEAMCLAW_MOCK_LLM: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
