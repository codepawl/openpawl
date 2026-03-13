import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Event Loop Protection", () => {
  beforeEach(async () => {
    const { restoreTerminal, initTerminalBroadcast } = await import("../src/core/terminal-broadcast.js");
    restoreTerminal();
    initTerminalBroadcast();
  });

  afterEach(async () => {
    const { restoreTerminal } = await import("../src/core/terminal-broadcast.js");
    restoreTerminal();
  });

  it("batching prevents event loop starvation", async () => {
    const { addTerminalClient, broadcastTerminalData, flushTerminalBuffer, removeTerminalClient } = await import("../src/core/terminal-broadcast.js");
    
    const send = vi.fn();
    addTerminalClient(send);

    const start = Date.now();
    
    for (let i = 0; i < 1000; i++) {
      broadcastTerminalData(`Log line ${i}\n`);
    }
    
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeLessThan(100);
    
    flushTerminalBuffer();
    expect(send).toHaveBeenCalled();
    
    removeTerminalClient(send);
  });

  it("flushBuffer processes all buffered data", async () => {
    const { addTerminalClient, broadcastTerminalData, flushTerminalBuffer, removeTerminalClient } = await import("../src/core/terminal-broadcast.js");
    
    const send = vi.fn();
    addTerminalClient(send);

    broadcastTerminalData("First\n");
    broadcastTerminalData("Second\n");
    broadcastTerminalData("Third\n");
    
    flushTerminalBuffer();
    
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload.payload.data).toBe("First\nSecond\nThird\n");
    
    removeTerminalClient(send);
  });

  it("does not send when no clients are connected", async () => {
    const { broadcastTerminalData, flushTerminalBuffer } = await import("../src/core/terminal-broadcast.js");
    
    expect(() => {
      broadcastTerminalData("Should not throw\n");
      flushTerminalBuffer();
    }).not.toThrow();
  });

  it("handles rapid sequential broadcasts efficiently", async () => {
    const { addTerminalClient, broadcastTerminalData, flushTerminalBuffer, removeTerminalClient } = await import("../src/core/terminal-broadcast.js");
    
    const send = vi.fn();
    addTerminalClient(send);

    const start = performance.now();
    
    for (let i = 0; i < 500; i++) {
      broadcastTerminalData(`x`);
    }
    
    const end = performance.now();
    
    expect(end - start).toBeLessThan(50);
    
    flushTerminalBuffer();
    expect(send).toHaveBeenCalledTimes(1);
    
    removeTerminalClient(send);
  });

  it("clears buffer after flush", async () => {
    const { addTerminalClient, broadcastTerminalData, flushTerminalBuffer, removeTerminalClient } = await import("../src/core/terminal-broadcast.js");
    
    const send = vi.fn();
    addTerminalClient(send);

    broadcastTerminalData("First batch\n");
    flushTerminalBuffer();
    
    const firstCallCount = send.mock.calls.length;
    
    broadcastTerminalData("Second batch\n");
    flushTerminalBuffer();
    
    expect(send.mock.calls.length).toBe(firstCallCount + 1);
    
    removeTerminalClient(send);
  });
});
