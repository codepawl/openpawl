import { describe, it, expect, vi } from "vitest";
import { CrashHandler } from "../../src/recovery/crash-handler.js";

describe("CrashHandler", () => {
  it("install registers process event handlers", () => {
    const onSpy = vi.spyOn(process, "on");
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const handler = new CrashHandler(shutdown);

    handler.install();
    expect(onSpy).toHaveBeenCalledWith("uncaughtException", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    handler.uninstall();
    onSpy.mockRestore();
  });

  it("uninstall removes all handlers", () => {
    const offSpy = vi.spyOn(process, "off");
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const handler = new CrashHandler(shutdown);

    handler.install();
    handler.uninstall();
    expect(offSpy).toHaveBeenCalled();

    offSpy.mockRestore();
  });
});
