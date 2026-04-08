import { describe, it, expect } from "bun:test";
import { PermissionResolver } from "../../src/tools/permissions.js";

describe("PermissionResolver", () => {
  it("auto permission → allowed immediately", () => {
    const resolver = new PermissionResolver();
    const result = resolver.checkPermission("file_read", "coder", "auto");
    expect(result).toEqual({ allowed: true });
  });

  it("block permission → not allowed", () => {
    const resolver = new PermissionResolver();
    const result = resolver.checkPermission("dangerous", "coder", "block");
    expect(result).toEqual({ allowed: false, reason: "blocked" });
  });

  it("confirm permission → needsConfirmation", () => {
    const resolver = new PermissionResolver();
    const result = resolver.checkPermission("shell_exec", "coder", "confirm");
    expect("needsConfirmation" in result && result.needsConfirmation).toBe(true);
  });

  it("session permission → needsConfirmation first time, auto after grant", () => {
    const resolver = new PermissionResolver();

    // First time → needs confirmation
    const first = resolver.checkPermission("git_ops", "coder", "session");
    expect("needsConfirmation" in first && first.needsConfirmation).toBe(true);

    // Grant session
    resolver.grantSession("git_ops");

    // Second time → auto
    const second = resolver.checkPermission("git_ops", "coder", "session");
    expect(second).toEqual({ allowed: true });
  });

  it("grantSession() makes subsequent checks auto", () => {
    const resolver = new PermissionResolver();
    resolver.grantSession("my_tool");
    const result = resolver.checkPermission("my_tool", "any", "session");
    expect(result).toEqual({ allowed: true });
  });

  it("resetSession() clears all grants", () => {
    const resolver = new PermissionResolver();
    resolver.grantSession("tool_a");
    resolver.grantSession("tool_b");
    resolver.resetSession();

    const result = resolver.checkPermission("tool_a", "any", "session");
    expect("needsConfirmation" in result && result.needsConfirmation).toBe(true);
  });
});
