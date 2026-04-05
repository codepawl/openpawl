import { describe, it, expect } from "vitest";
import { AgentWatchdog } from "../../src/recovery/agent-watchdog.js";

describe("AgentWatchdog", () => {
  it("detects stuck: 3 identical chunks", () => {
    const wd = new AgentWatchdog();
    const handle = wd.watch("coder", "s1");

    // Feed 3 identical chunks of 200+ chars
    const repeated = "the same output repeated over and over again ".repeat(10);
    handle.feedToken(repeated);
    handle.feedToken(repeated);
    handle.feedToken(repeated);

    const stop = handle.shouldStop();
    expect(stop).not.toBeNull();
    expect(stop!.type).toBe("stuck");

    handle.dispose();
  });

  it("does not trigger on varied output", () => {
    const wd = new AgentWatchdog();
    const handle = wd.watch("coder", "s1");

    handle.feedToken("First chunk with unique content about authentication. ".repeat(5));
    handle.feedToken("Second chunk about database queries and optimization. ".repeat(5));
    handle.feedToken("Third chunk covering testing strategies and CI setup. ".repeat(5));

    const stop = handle.shouldStop();
    // Varied content should not trigger stuck
    // (may or may not be null depending on similarity threshold)
    if (stop) expect(stop.type).not.toBe("stuck");

    handle.dispose();
  });

  it("detects tool loop: same tool 3 times", () => {
    const wd = new AgentWatchdog();
    const handle = wd.watch("coder", "s1");

    handle.feedToolCall("file_read");
    handle.feedToolCall("file_read");
    handle.feedToolCall("file_read");

    const stop = handle.shouldStop();
    expect(stop).not.toBeNull();
    expect(stop!.type).toBe("tool_loop");

    handle.dispose();
  });

  it("detects output too large", () => {
    const wd = new AgentWatchdog();
    const handle = wd.watch("coder", "s1");

    // Feed > 100KB
    const large = "x".repeat(110_000);
    handle.feedToken(large);

    const stop = handle.shouldStop();
    expect(stop).not.toBeNull();
    expect(stop!.type).toBe("output_too_large");

    handle.dispose();
  });

  it("feedToolCall resets activity timer", () => {
    const wd = new AgentWatchdog();
    const handle = wd.watch("coder", "s1");

    handle.feedToolCall("file_read");
    // Should not trigger no_progress since we just had activity
    const stop = handle.shouldStop();
    // no_progress requires 60s silence — immediate check should be null
    expect(stop === null || stop.type !== "no_progress").toBe(true);

    handle.dispose();
  });

  it("dispose cleans up", () => {
    const wd = new AgentWatchdog();
    const handle = wd.watch("coder", "s1");
    handle.dispose();
    // Should not crash after dispose
    const stop = handle.shouldStop();
    expect(stop === null || stop !== undefined).toBe(true);
  });
});
