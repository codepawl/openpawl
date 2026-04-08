import { describe, it, expect } from "bun:test";
import { parseLlmJson } from "@/utils/jsonExtractor.js";

describe("parseLlmJson (Robust JSON Extraction)", () => {
  describe("perfect JSON", () => {
    it("parses valid JSON object", () => {
      const input = '{"description": "task", "assigned_to": "bot_0", "worker_tier": "light", "complexity": "LOW"}';
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result).toEqual({
        description: "task",
        assigned_to: "bot_0",
        worker_tier: "light",
        complexity: "LOW",
      });
    });

    it("parses valid JSON array", () => {
      const input = '[{"id": 1}, {"id": 2}]';
      const result = parseLlmJson<unknown[]>(input);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });
  });

  describe("JSON with Preamble", () => {
    it("extracts JSON from text before it", () => {
      const input = `Here is the plan:
{"description": "Implement login", "assigned_to": "bot_0"}`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.description).toBe("Implement login");
    });

    it("extracts JSON from conversational preamble", () => {
      const input = `I've added the tasks for you below:

{"description": "Build API", "assigned_to": "bot_1"}`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.description).toBe("Build API");
    });

    it("handles markdown preamble", () => {
      const input = `Sure! Here's the JSON:

{"task": "test"}`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.task).toBe("test");
    });
  });

  describe("JSON with Postscript", () => {
    it("extracts JSON from text after it", () => {
      const input = `{"description": "task", "assigned_to": "bot_0"}
Hope this helps!`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.assigned_to).toBe("bot_0");
    });

    it("extracts JSON with trailing text", () => {
      const input = `{"key": "value"}
Let me know if you need changes.`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.key).toBe("value");
    });
  });

  describe("JSON in code fences", () => {
    it("extracts JSON from ```json code block", () => {
      const input = `Here is the result:
\`\`\`json
{"task": "done"}
\`\`\``;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.task).toBe("done");
    });

    it("extracts JSON from ``` code block without json lang", () => {
      const input = `Try this:
\`\`\`
{"data": 123}
\`\`\``;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.data).toBe(123);
    });
  });

  describe("multi-line JSON with nested objects", () => {
    it("parses complex nested JSON", () => {
      const input = `{
  "techStack": {
    "languages": ["TypeScript"],
    "frameworks": ["Fastify"]
  },
  "componentArchitecture": "Test"
}`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.techStack).toBeDefined();
      expect((result.techStack as Record<string, unknown>).languages).toEqual(["TypeScript"]);
    });

    it("handles multi-line JSON with preamble", () => {
      const input = `I've prepared the architecture:

{
  "techStack": {"languages": ["Python"]},
  "componentArchitecture": "Microservices"
}

Let me know if you need modifications.`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.techStack).toBeDefined();
    });
  });

  describe("malformed string with no JSON", () => {
    it("throws clear error when no JSON found", () => {
      const input = "This is just plain text with no JSON at all";
      expect(() => parseLlmJson(input)).toThrow(/Failed to parse|JSON_NOT_FOUND|cannot extract/i);
    });

    it("throws when input is empty", () => {
      expect(() => parseLlmJson("")).toThrow();
    });

    it("throws when input is only whitespace", () => {
      expect(() => parseLlmJson("   \n\n   ")).toThrow();
    });
  });

  describe("filename prefix in code fence", () => {
    it("extracts JSON when code fence contains a filename prefix", () => {
      const input = `\`\`\`json
sprint-plan.json
{"sprintGoal": "Implement auth", "tasks": []}
\`\`\``;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.sprintGoal).toBe("Implement auth");
    });

    it("extracts JSON when filename prefix appears without code fence", () => {
      const input = `sprint-plan.json
{"sprintGoal": "Implement auth", "tasks": []}`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.sprintGoal).toBe("Implement auth");
    });
  });

  describe("edge cases", () => {
    it("handles JSON with reasoning blocks stripped", () => {
      const input = `<think>
Thinking about the task...
</think>
{"task": "actual work"}`;
      const result = parseLlmJson<Record<string, unknown>>(input);
      expect(result.task).toBe("actual work");
    });

    it("handles array with preamble and postscript", () => {
      const input = `Here are the items:
[{"id": 1}, {"id": 2}]
That's the list!`;
      const result = parseLlmJson<unknown[]>(input);
      expect(result).toHaveLength(2);
    });
  });
});
