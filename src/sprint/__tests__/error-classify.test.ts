import { describe, it, expect } from "bun:test";
import { classifyError } from "../error-classify.js";

describe("classifyError", () => {
  it("classifies exit 127 with stderr 'command not found' as env_command_not_found", () => {
    expect(classifyError({ exitCode: 127, stderr: "npm: command not found" })).toEqual({
      kind: "env_command_not_found",
      signal: "exit 127",
    });
  });

  it("classifies ENOENT errors as env_missing_dep", () => {
    expect(classifyError({ errorText: "ENOENT no such file" }).kind).toBe("env_missing_dep");
  });

  it("classifies permission denied errors as env_perm", () => {
    expect(classifyError({ errorText: "permission denied" }).kind).toBe("env_perm");
  });

  it("classifies EADDRINUSE as env_port_in_use", () => {
    expect(classifyError({ errorText: "EADDRINUSE" }).kind).toBe("env_port_in_use");
  });

  it("classifies 'timed out' messages as timeout", () => {
    expect(classifyError({ errorText: "timed out after 30s" }).kind).toBe("timeout");
  });

  it("classifies type errors as agent_logic", () => {
    expect(classifyError({ errorText: "TypeError: foo is not a function" }).kind).toBe("agent_logic");
  });

  it("returns unknown for unrecognized text", () => {
    expect(classifyError({ errorText: "random garbage xyzzy" }).kind).toBe("unknown");
  });

  it("returns unknown for empty input (caller decides whether to classify)", () => {
    expect(classifyError({ exitCode: 0, stderr: "" }).kind).toBe("unknown");
    expect(classifyError({}).kind).toBe("unknown");
  });

  it("prefers structured exitCode over regex ambiguity", () => {
    // stderr alone could match env_missing_dep via ENOENT, but exit 127 wins
    expect(classifyError({ exitCode: 127, stderr: "ENOENT: not found" }).kind).toBe(
      "env_command_not_found",
    );
  });
});
