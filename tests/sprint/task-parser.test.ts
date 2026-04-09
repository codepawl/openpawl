import { describe, it, expect } from "vitest";
import { parseTasks } from "../../src/sprint/task-parser.js";

describe("parseTasks", () => {
  it("parses a JSON array in a fenced code block", () => {
    const input = `Here is the plan:\n\n\`\`\`json\n[\n  {"description": "Set up project structure"},\n  {"description": "Create API endpoints"},\n  {"description": "Write tests"}\n]\n\`\`\``;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.id).toBe("task-1");
    expect(tasks[0]!.description).toBe("Set up project structure");
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[2]!.id).toBe("task-3");
  });

  it("parses a numbered list", () => {
    const input = "Sprint plan:\n1. Design the database schema\n2. Implement user authentication\n3. Create REST API endpoints\n4. Write integration tests";

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]!.description).toBe("Design the database schema");
    expect(tasks[3]!.description).toBe("Write integration tests");
  });

  it("parses a raw JSON array (no fencing)", () => {
    const input = `[{"description": "Task A"}, {"description": "Task B"}]`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.description).toBe("Task A");
  });

  it("returns empty array for empty input", () => {
    expect(parseTasks("")).toHaveLength(0);
    expect(parseTasks("No tasks here.")).toHaveLength(0);
  });

  it("handles numbered list with extra whitespace and markdown", () => {
    const input = "\n1.  **Design** the schema\n2.  Implement the **routes**\n";

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.description).toBe("**Design** the schema");
    expect(tasks[1]!.description).toBe("Implement the **routes**");
  });

  it("parses JSON with dependsOn field", () => {
    const input = `[{"description": "Setup project", "dependsOn": []}, {"description": "Create DB", "dependsOn": [1]}, {"description": "Add auth", "dependsOn": [1, 2]}]`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.dependsOn).toBeUndefined();
    expect(tasks[1]!.dependsOn).toEqual([1]);
    expect(tasks[2]!.dependsOn).toEqual([1, 2]);
  });

  it("handles JSON without dependsOn gracefully", () => {
    const input = `[{"description": "Task A"}, {"description": "Task B"}]`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.dependsOn).toBeUndefined();
    expect(tasks[1]!.dependsOn).toBeUndefined();
  });
});
