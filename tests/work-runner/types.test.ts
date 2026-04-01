/**
 * Tests for work-runner/types.ts — error types for session control flow.
 */
import { describe, it, expect } from "vitest";
import { UserCancelError, FatalSessionError } from "@/work-runner/types.js";

describe("UserCancelError", () => {
  it("has correct name and default message", () => {
    const err = new UserCancelError();
    expect(err.name).toBe("UserCancelError");
    expect(err.message).toBe("Work session cancelled.");
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts custom message", () => {
    const err = new UserCancelError("Aborted by user.");
    expect(err.message).toBe("Aborted by user.");
  });

  it("is catchable with instanceof", () => {
    try {
      throw new UserCancelError();
    } catch (err) {
      expect(err instanceof UserCancelError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });
});

describe("FatalSessionError", () => {
  it("has correct name and message", () => {
    const err = new FatalSessionError("No providers configured");
    expect(err.name).toBe("FatalSessionError");
    expect(err.message).toBe("No providers configured");
    expect(err).toBeInstanceOf(Error);
  });

  it("is distinguishable from UserCancelError", () => {
    const cancel = new UserCancelError();
    const fatal = new FatalSessionError("boom");
    expect(cancel instanceof FatalSessionError).toBe(false);
    expect(fatal instanceof UserCancelError).toBe(false);
  });
});
