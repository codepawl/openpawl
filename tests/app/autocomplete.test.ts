/**
 * Tests for combined autocomplete provider.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutocompleteProvider } from "../../src/app/autocomplete.js";
import { CommandRegistry } from "../../src/tui/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teamclaw-autocomplete-test-"));
  writeFileSync(path.join(tmpDir, "README.md"), "# Hello");
  writeFileSync(path.join(tmpDir, "index.ts"), "export {}");
});

describe("createAutocompleteProvider", () => {
  it("suggests slash commands for / prefix", () => {
    const registry = new CommandRegistry();
    registry.register({ name: "work", description: "Start work", execute: async () => {} });
    registry.register({ name: "status", description: "Show status", execute: async () => {} });

    const provider = createAutocompleteProvider(registry, tmpDir);
    const suggestions = provider.getSuggestions("/wo", 3);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.label).toBe("/work");
  });

  it("suggests files for @ prefix", () => {
    const registry = new CommandRegistry();
    const provider = createAutocompleteProvider(registry, tmpDir);
    const suggestions = provider.getSuggestions("@READ", 5);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.label).toContain("@README.md");
  });

  it("returns empty for plain text", () => {
    const registry = new CommandRegistry();
    const provider = createAutocompleteProvider(registry, tmpDir);
    const suggestions = provider.getSuggestions("hello world", 11);
    expect(suggestions).toEqual([]);
  });

  it("filters file suggestions by partial name", () => {
    const registry = new CommandRegistry();
    const provider = createAutocompleteProvider(registry, tmpDir);
    const suggestions = provider.getSuggestions("@index", 6);

    expect(suggestions.some((s) => s.label.includes("index.ts"))).toBe(true);
    expect(suggestions.some((s) => s.label.includes("README"))).toBe(false);
  });
});
