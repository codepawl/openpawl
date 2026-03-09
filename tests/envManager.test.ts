import { describe, expect, test } from "vitest";
import { getEnvValue, setEnvValue, unsetEnvKey } from "../src/core/envManager.js";

describe("envManager", () => {
  test("getEnvValue returns last active assignment and ignores commented lines", () => {
    const lines = [
      "# OPENAI_API_KEY=commented",
      "OPENAI_API_KEY=first",
      "OTHER=1",
      "OPENAI_API_KEY=second",
    ];
    expect(getEnvValue("OPENAI_API_KEY", lines)).toBe("second");
  });

  test("setEnvValue updates last occurrence and removes earlier duplicates", () => {
    const lines = ["A=1", "X=old1", "# X=comment", "X=old2", "B=2"];
    const next = setEnvValue("X", "new", lines);
    expect(next).toEqual(["A=1", "# X=comment", "X=new", "B=2"]);
  });

  test("setEnvValue appends when missing (trims trailing blank lines only)", () => {
    const lines = ["# header", "", "A=1", "", ""];
    const next = setEnvValue("NEW_KEY", "v", lines);
    expect(next).toEqual(["# header", "", "A=1", "NEW_KEY=v"]);
  });

  test("unsetEnvKey removes active assignments and keeps comments", () => {
    const lines = ["X=1", "# X=comment", "Y=2", "X=3"];
    const next = unsetEnvKey("X", lines);
    expect(next).toEqual(["# X=comment", "Y=2"]);
  });
});

