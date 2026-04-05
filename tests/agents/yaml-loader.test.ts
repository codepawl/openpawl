import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { AgentYamlLoader } from "../../src/agents/customization/yaml-loader.js";

describe("AgentYamlLoader", () => {
  let tmpDir: string;
  let loader: AgentYamlLoader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-yaml-test-"));
    loader = new AgentYamlLoader();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads valid YAML file", async () => {
    const yaml = { id: "test-agent", name: "Test Agent", description: "A test" };
    await writeFile(path.join(tmpDir, "test.yaml"), stringifyYaml(yaml));

    const result = await loader.loadFile(path.join(tmpDir, "test.yaml"), "user");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().id).toBe("test-agent");
  });

  it("returns error for invalid YAML syntax", async () => {
    await writeFile(path.join(tmpDir, "bad.yaml"), "{ invalid yaml: [");
    const result = await loader.loadFile(path.join(tmpDir, "bad.yaml"), "user");
    expect(result.isErr()).toBe(true);
  });

  it("returns error for schema validation failure", async () => {
    await writeFile(path.join(tmpDir, "invalid.yaml"), stringifyYaml({ id: "UPPERCASE", name: "" }));
    const result = await loader.loadFile(path.join(tmpDir, "invalid.yaml"), "user");
    expect(result.isErr()).toBe(true);
  });

  it("skips hidden files", async () => {
    await writeFile(path.join(tmpDir, ".hidden.yaml"), stringifyYaml({ id: "hidden", name: "H", description: "d" }));
    await writeFile(path.join(tmpDir, "_disabled.yaml"), stringifyYaml({ id: "disabled", name: "D", description: "d" }));
    await writeFile(path.join(tmpDir, "visible.yaml"), stringifyYaml({ id: "visible", name: "V", description: "d" }));

    const result = await loader.loadDirectory(tmpDir, "user");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]!.id).toBe("visible");
  });

  it("loads multiple files from directory", async () => {
    await writeFile(path.join(tmpDir, "a.yaml"), stringifyYaml({ id: "agent-a", name: "A", description: "d" }));
    await writeFile(path.join(tmpDir, "b.yaml"), stringifyYaml({ id: "agent-b", name: "B", description: "d" }));

    const result = await loader.loadDirectory(tmpDir, "user");
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });

  it("higher priority directory overrides lower for same ID", async () => {
    const highDir = path.join(tmpDir, "high");
    const lowDir = path.join(tmpDir, "low");
    await mkdir(highDir, { recursive: true });
    await mkdir(lowDir, { recursive: true });

    await writeFile(path.join(lowDir, "agent.yaml"), stringifyYaml({ id: "my-agent", name: "Low", description: "d" }));
    await writeFile(path.join(highDir, "agent.yaml"), stringifyYaml({ id: "my-agent", name: "High", description: "d" }));

    const result = await loader.loadAll([
      { path: highDir, source: "project", priority: 1 },
      { path: lowDir, source: "user", priority: 2 },
    ]);

    expect(result.isOk()).toBe(true);
    const agent = result._unsafeUnwrap().agents.get("my-agent");
    expect(agent?.yaml.name).toBe("High");
  });

  it("JSON files also loaded", async () => {
    await writeFile(path.join(tmpDir, "agent.json"), JSON.stringify({ id: "json-agent", name: "JSON", description: "d" }));
    const result = await loader.loadDirectory(tmpDir, "user");
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it("empty directory returns empty result", async () => {
    const result = await loader.loadDirectory(tmpDir, "user");
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });
});
