/**
 * Shared @clack/prompts mock factory.
 * Provides controllable responses for interactive prompts.
 */
import { vi } from "vitest";

export function createMockClack() {
  return {
    text: vi.fn().mockResolvedValue("mock-text-input"),
    select: vi.fn().mockResolvedValue("mock-option"),
    confirm: vi.fn().mockResolvedValue(true),
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    isCancel: vi.fn().mockReturnValue(false),
    spinner: vi.fn().mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    }),
    multiselect: vi.fn().mockResolvedValue([]),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
  };
}
