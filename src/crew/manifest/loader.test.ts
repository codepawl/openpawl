import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadManifestFromDir,
  loadUserCrew,
  listUserCrewNames,
  userCrewDir,
} from "./loader.js";
import { ensureBuiltInPresets, FULL_STACK_PRESET } from "./presets.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), "openpawl-manifest-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function writeManifest(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.yaml"), body, "utf-8");
}

function writeAgentMd(dir: string, relPath: string, body: string): void {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf-8");
}

describe("loadManifestFromDir", () => {
  it("loads a minimal valid manifest and inlines prompt files", () => {
    const dir = path.join(homeDir, "team");
    writeManifest(
      dir,
      `name: team
description: A small team
agents:
  - id: coder
    name: Coder
    description: writes code
    prompt_file: agents/coder.md
    tools: [file_read, file_write]
  - id: reviewer
    name: Reviewer
    description: reviews code
    prompt_file: agents/reviewer.md
    tools: [file_read]
`,
    );
    writeAgentMd(dir, "agents/coder.md", "You are the coder. Implement the task.");
    writeAgentMd(dir, "agents/reviewer.md", "You are the reviewer. Audit the diff.");

    const manifest = loadManifestFromDir(dir);
    expect(manifest.name).toBe("team");
    expect(manifest.agents).toHaveLength(2);
    expect(manifest.agents[0]?.prompt).toContain("Implement the task");
    expect(manifest.agents[1]?.tools).toEqual(["file_read"]);
    expect(manifest.constraints.min_agents).toBe(2);
  });

  it("throws when manifest.yaml is missing", () => {
    const dir = path.join(homeDir, "missing");
    mkdirSync(dir, { recursive: true });
    expect(() => loadManifestFromDir(dir)).toThrow(/manifest not found/);
  });

  it("throws when prompt_file does not exist", () => {
    const dir = path.join(homeDir, "team");
    writeManifest(
      dir,
      `name: team
description: x
agents:
  - id: a
    name: A
    description: a
    prompt_file: agents/a.md
    tools: [file_read]
  - id: b
    name: B
    description: b
    prompt_file: agents/b.md
    tools: [file_read]
`,
    );
    writeAgentMd(dir, "agents/a.md", "Some prompt content here.");
    // b.md intentionally absent

    expect(() => loadManifestFromDir(dir)).toThrow(/prompt_file not found/);
  });

  it("listUserCrewNames returns directories under ~/.openpawl/crews/", () => {
    expect(listUserCrewNames(homeDir)).toEqual([]);
    mkdirSync(userCrewDir("alpha", homeDir), { recursive: true });
    mkdirSync(userCrewDir("zeta", homeDir), { recursive: true });
    expect(listUserCrewNames(homeDir)).toEqual(["alpha", "zeta"]);
  });

  it("loadUserCrew loads from ~/.openpawl/crews/<name>", () => {
    const dir = userCrewDir("crew1", homeDir);
    writeManifest(
      dir,
      `name: crew1
description: x
agents:
  - id: a
    name: A
    description: a
    prompt_file: agents/a.md
    tools: [file_read]
  - id: b
    name: B
    description: b
    prompt_file: agents/b.md
    tools: [file_read]
`,
    );
    writeAgentMd(dir, "agents/a.md", "Prompt for agent a.");
    writeAgentMd(dir, "agents/b.md", "Prompt for agent b.");
    const m = loadUserCrew("crew1", homeDir);
    expect(m.agents.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("ensureBuiltInPresets + full-stack preset", () => {
  it("seeds the full-stack preset on first run, then is idempotent", () => {
    const first = ensureBuiltInPresets(homeDir);
    expect(first.installed).toContain(FULL_STACK_PRESET);
    expect(first.skipped).toEqual([]);

    const dest = userCrewDir(FULL_STACK_PRESET, homeDir);
    expect(existsSync(path.join(dest, "manifest.yaml"))).toBe(true);
    const agentFiles = readdirSync(path.join(dest, "agents")).sort();
    expect(agentFiles).toEqual(["coder.md", "planner.md", "reviewer.md", "tester.md"]);

    const second = ensureBuiltInPresets(homeDir);
    expect(second.installed).toEqual([]);
    expect(second.skipped).toContain(FULL_STACK_PRESET);
  });

  it("seeded full-stack preset loads + matches Prompt 4 capability rules", () => {
    ensureBuiltInPresets(homeDir);
    const m = loadUserCrew(FULL_STACK_PRESET, homeDir);

    expect(m.agents.map((a) => a.id).sort()).toEqual([
      "coder",
      "planner",
      "reviewer",
      "tester",
    ]);

    const reviewer = m.agents.find((a) => a.id === "reviewer")!;
    const planner = m.agents.find((a) => a.id === "planner")!;
    expect(reviewer.tools).toEqual(["file_read", "file_list"]);
    expect(planner.tools).toEqual(["file_read", "file_list"]);

    const tester = m.agents.find((a) => a.id === "tester")!;
    expect(tester.tools).not.toContain("file_edit");
    expect(tester.tools).toContain("file_write");
    expect(tester.write_scope?.length).toBeGreaterThan(0);
    expect(tester.write_scope?.some((g) => g.includes("test"))).toBe(true);
  });
});
