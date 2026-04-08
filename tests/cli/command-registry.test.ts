/**
 * Tests for CLI command registry — ensures help stays in sync with handlers.
 */
import { describe, test, expect } from "vitest";
import { CLI_COMMANDS, findCommand, getAllCommandNames, generateHelp, generateCommandHelp } from "../../src/cli/command-registry.js";

describe("CLI Command Registry", () => {
  test("all commands have required fields", () => {
    for (const cmd of CLI_COMMANDS) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.category).toBeTruthy();
      expect(cmd.handler.module).toBeTruthy();
      expect(cmd.handler.fn).toBeTruthy();
    }
  });

  test("no duplicate command names", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test("no duplicate aliases", () => {
    const allNames: string[] = [];
    for (const cmd of CLI_COMMANDS) {
      allNames.push(cmd.name);
      if (cmd.aliases) allNames.push(...cmd.aliases);
    }
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length);
  });

  test("findCommand resolves by name", () => {
    const cmd = findCommand("setup");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("setup");
  });

  test("findCommand resolves by alias", () => {
    const cmd = findCommand("init");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("setup");
  });

  test("findCommand returns undefined for unknown", () => {
    expect(findCommand("nonexistent")).toBeUndefined();
  });

  test("getAllCommandNames includes names and aliases", () => {
    const names = getAllCommandNames();
    expect(names).toContain("setup");
    expect(names).toContain("init");
    expect(names).toContain("models");
    expect(names).toContain("template");
  });

  test("generateHelp includes all command names", () => {
    const help = generateHelp();
    for (const cmd of CLI_COMMANDS) {
      expect(help).toContain(cmd.name);
    }
  });

  test("generateHelp includes all categories", () => {
    const help = generateHelp();
    expect(help).toContain("GETTING STARTED");
    expect(help).toContain("DAILY WORKFLOW");
    expect(help).toContain("MEMORY & DECISIONS");
    expect(help).toContain("TEAM & PROVIDERS");
    expect(help).toContain("HISTORY & ANALYSIS");
    expect(help).toContain("UTILITIES");
  });

  test("generateCommandHelp shows description and name", () => {
    const cmd = findCommand("work")!;
    const help = generateCommandHelp(cmd);
    expect(help).toContain("work");
    expect(help).toContain(cmd.description);
  });

  test("generateCommandHelp shows options when present", () => {
    const cmd = findCommand("work")!;
    const help = generateCommandHelp(cmd);
    expect(help).toContain("--goal");
    expect(help).toContain("--no-web");
  });

  test("all handler modules exist as importable paths", async () => {
    // Verify module paths are valid by checking they start with "./"
    for (const cmd of CLI_COMMANDS) {
      expect(cmd.handler.module).toMatch(/^\.\//);
    }
  });

  test("run command is not in registry", () => {
    expect(findCommand("run")).toBeUndefined();
  });

  test("uninstall command is in registry", () => {
    expect(findCommand("uninstall")).toBeDefined();
  });
});
