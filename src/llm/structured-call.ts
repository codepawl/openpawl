/**
 * Typed LLM caller — uses Instructor.js for structured output with
 * automatic retries and Zod validation.
 */

import { createInstructorClient, type InstructorProviderConfig } from "./instructor-client.js";
import type { z } from "zod";

export async function structuredCall<T extends z.AnyZodObject>({
  provider,
  model,
  messages,
  schema,
  schemaName,
  maxRetries = 3,
  systemPrompt,
}: {
  provider: InstructorProviderConfig;
  model: string;
  messages: { role: "user" | "assistant"; content: string }[];
  schema: T;
  schemaName: string;
  maxRetries?: number;
  systemPrompt?: string;
}): Promise<z.infer<T>> {
  const client = createInstructorClient(provider);

  const allMessages = systemPrompt
    ? [{ role: "system" as const, content: systemPrompt }, ...messages]
    : messages;

  const result = await client.chat.completions.create({
    model,
    messages: allMessages,
    response_model: { schema, name: schemaName },
    max_retries: maxRetries,
  });

  return result as z.infer<T>;
}
