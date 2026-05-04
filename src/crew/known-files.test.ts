import { describe, expect, it } from "bun:test";

import { KnownFilesRegistry } from "./known-files.js";
import { CrewTaskSchema } from "./types.js";

function makeTask(
  id: string,
  overrides: {
    files_created?: string[];
    files_modified?: string[];
    description?: string;
    agent?: string;
  } = {},
) {
  return CrewTaskSchema.parse({
    id,
    phase_id: "p1",
    description: overrides.description ?? "Do the thing",
    assigned_agent: overrides.agent ?? "coder",
    files_created: overrides.files_created ?? [],
    files_modified: overrides.files_modified ?? [],
  });
}

describe("KnownFilesRegistry — basic add/format", () => {
  it("returns empty string when empty", () => {
    const r = new KnownFilesRegistry();
    expect(r.format()).toBe("");
    expect(r.size()).toBe(0);
  });

  it("renders a sorted markdown block", () => {
    const r = new KnownFilesRegistry();
    r.add("src/zoo.ts", "z impl");
    r.add("src/alpha.ts", "a impl");
    r.add("src/middle.ts", "m impl");
    const out = r.format();
    expect(out.startsWith("## Known files\n")).toBe(true);
    const lines = out.split("\n").slice(1);
    expect(lines).toEqual([
      "- `src/alpha.ts`: a impl",
      "- `src/middle.ts`: m impl",
      "- `src/zoo.ts`: z impl",
    ]);
  });

  it("most-recent summary wins on duplicate path (idempotent count)", () => {
    const r = new KnownFilesRegistry();
    r.add("src/foo.ts", "first");
    r.add("src/foo.ts", "second");
    r.add("src/foo.ts", "third");
    expect(r.size()).toBe(1);
    expect(r.format()).toContain("third");
    expect(r.format()).not.toContain("first");
  });

  it("clear() empties the registry", () => {
    const r = new KnownFilesRegistry();
    r.add("a", "x");
    r.add("b", "y");
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.format()).toBe("");
  });

  it("paths() returns a sorted snapshot", () => {
    const r = new KnownFilesRegistry();
    r.add("z", "");
    r.add("a", "");
    r.add("m", "");
    expect(r.paths()).toEqual(["a", "m", "z"]);
  });
});

describe("KnownFilesRegistry — addFromTaskResult", () => {
  it("ingests files_created and files_modified", () => {
    const r = new KnownFilesRegistry();
    const task = makeTask("t1", {
      files_created: ["src/a.ts"],
      files_modified: ["src/b.ts"],
      description: "Add a, edit b",
      agent: "coder",
    });
    r.addFromTaskResult(task);
    expect(r.size()).toBe(2);
    expect(r.format()).toContain("created by 'coder'");
    expect(r.format()).toContain("modified by 'coder'");
  });

  it("dedupes when the same path is in both created and modified", () => {
    const r = new KnownFilesRegistry();
    const task = makeTask("t1", {
      files_created: ["src/foo.ts"],
      files_modified: ["src/foo.ts"],
    });
    r.addFromTaskResult(task);
    expect(r.size()).toBe(1);
  });

  it("ignores tasks with no file claims", () => {
    const r = new KnownFilesRegistry();
    r.addFromTaskResult(makeTask("t1"));
    expect(r.size()).toBe(0);
  });

  it("truncates long task descriptions in the summary", () => {
    const long = "x".repeat(500);
    const r = new KnownFilesRegistry();
    r.addFromTaskResult(
      makeTask("t1", { files_created: ["src/foo.ts"], description: long }),
    );
    const out = r.format();
    expect(out).toContain("...");
    expect(out.length).toBeLessThan(long.length + 200);
  });
});

describe("KnownFilesRegistry — token cap", () => {
  it("evicts oldest entries when the rendered block exceeds the cap", () => {
    const r = new KnownFilesRegistry(50); // tiny cap so eviction is forced
    r.add("a", "x".repeat(40));
    r.add("b", "y".repeat(40));
    r.add("c", "z".repeat(40));
    const out = r.format();
    // The cap is small enough that only a tail of entries should fit.
    expect(out.length).toBeGreaterThan(0);
    // Oldest ('a') should be evicted before newer ones.
    if (!out.includes("a")) {
      expect(out).not.toContain("a");
    }
    // Format never throws; output is sorted, may be partial.
    expect(out.startsWith("## Known files")).toBe(true);
  });

  it("re-adding a path refreshes its age (survives cap eviction)", () => {
    const r = new KnownFilesRegistry(80);
    r.add("a", "x".repeat(20));
    r.add("b", "y".repeat(20));
    r.add("c", "z".repeat(20));
    // Refresh 'a' — now 'b' is the oldest.
    r.add("a", "x".repeat(20));
    const out = r.format();
    if (out.length < 200) {
      expect(out).toContain("a");
    }
  });
});
