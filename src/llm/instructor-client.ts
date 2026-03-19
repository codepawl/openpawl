/**
 * Instructor.js client factory — wraps raw SDK clients (Anthropic / OpenAI)
 * for structured LLM output via tool-call extraction.
 */

import Instructor from "@instructor-ai/instructor";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface InstructorProviderConfig {
  type: "anthropic" | "openai-compatible";
  apiKey: string;
  baseUrl?: string;
}

export function createInstructorClient(config: InstructorProviderConfig) {
  if (config.type === "anthropic") {
    return Instructor({
      client: new Anthropic({ apiKey: config.apiKey }),
      mode: "TOOLS",
    });
  }

  return Instructor({
    client: new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    }),
    mode: "TOOLS",
  });
}
