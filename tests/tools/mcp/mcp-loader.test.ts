import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { McpLoader } from "../../../src/tools/mcp/mcp-loader.js";
import { jsonSchemaToZod } from "../../../src/tools/mcp/mcp-adapter.js";

describe("McpLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads tools from mock MCP server", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tools: [
          { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
          { name: "create_pr", description: "Create PR", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
        ],
      }),
    });

    const loader = new McpLoader();
    const result = await loader.loadTools({ name: "github", url: "https://mcp.github.com" });

    expect(result.isOk()).toBe(true);
    const tools = result._unsafeUnwrap();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("mcp_github_search_issues");
    expect(tools[1]!.name).toBe("mcp_github_create_pr");
  });

  it("namespaces tool names with server name", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tools: [{ name: "query", description: "Query", inputSchema: {} }] }),
    });

    const loader = new McpLoader();
    const result = await loader.loadTools({ name: "myserver", url: "http://localhost:3000" });
    expect(result._unsafeUnwrap()[0]!.name).toBe("mcp_myserver_query");
  });

  it("handles server connection failure gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const loader = new McpLoader();
    const result = await loader.loadTools({ name: "offline", url: "http://localhost:9999" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("mcp_error");
  });

  it("disconnect removes server from connected list", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tools: [] }),
    });

    const loader = new McpLoader();
    await loader.loadTools({ name: "test", url: "http://localhost" });
    expect(loader.getConnectedServers()).toContain("test");

    await loader.disconnect("test");
    expect(loader.getConnectedServers()).not.toContain("test");
  });
});

describe("jsonSchemaToZod", () => {
  it("converts string type", () => {
    const schema = jsonSchemaToZod({ type: "string" });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(123).success).toBe(false);
  });

  it("converts number type", () => {
    const schema = jsonSchemaToZod({ type: "number" });
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse("str").success).toBe(false);
  });

  it("converts object with properties", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(schema.safeParse({ name: "test" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // missing required name
  });

  it("handles unknown schema gracefully", () => {
    const schema = jsonSchemaToZod({});
    expect(schema.safeParse("anything").success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
  });
});
