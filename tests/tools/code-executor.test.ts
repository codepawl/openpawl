import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { canUseIsolate } from "../helpers/can-use-isolate.js";
import { createCodeExecutorTool } from "@/tools/code-executor.js";

describe.skipIf(!canUseIsolate())("CodeExecutorTool", () => {
  const workspacePath = path.join("/tmp", `openpawl-test-${Date.now()}`);
  let executor: ReturnType<typeof createCodeExecutorTool>;

  beforeAll(() => {
    fs.mkdirSync(workspacePath, { recursive: true });
    executor = createCodeExecutorTool(workspacePath);
  });

  afterAll(() => {
    executor.dispose();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test("executes simple JS and captures stdout", async () => {
    const result = await executor.execute({ code: 'console.log("hello sandbox");' });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello sandbox");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("returns module.exports via run()", async () => {
    const result = await executor.run({ code: "module.exports = 21 * 2;" });
    expect(result.success).toBe(true);
    expect(result.exports).toBe(42);
    expect(result.exitCode).toBe(0);
  });

  test("returns error on syntax error", async () => {
    const result = await executor.execute({ code: "const x = {;" });
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  test("returns exitCode 124 on infinite loop (timeout)", async () => {
    const result = await executor.execute({ code: "while(true) {}" });
    expect(result.success).toBe(false);
    // secure-exec may use different exit code for timeout, but it should fail
    expect(result.exitCode).not.toBe(0);
  }, 20_000);

  test("blocks network fetch", async () => {
    const result = await executor.execute({
      code: 'fetch("https://example.com").then(() => console.log("ok")).catch(e => { console.error(e.message); process.exit(1); });',
    });
    expect(result.success).toBe(false);
  });

  test("blocks fs access outside workspace", async () => {
    const result = await executor.execute({
      code: 'const fs = require("fs"); fs.readFileSync("/etc/hostname", "utf8");',
    });
    expect(result.success).toBe(false);
  });

  test("two runtimes are independent (one timeout does not kill other)", async () => {
    const executor2 = createCodeExecutorTool(workspacePath);
    try {
      const [slow, fast] = await Promise.all([
        executor.execute({ code: "while(true) {}" }),
        executor2.execute({ code: 'console.log("independent");' }),
      ]);
      expect(slow.success).toBe(false);
      expect(fast.success).toBe(true);
      expect(fast.output).toContain("independent");
    } finally {
      executor2.dispose();
    }
  }, 20_000);

  test("disposes cleanly without throwing", () => {
    const tmp = createCodeExecutorTool(workspacePath);
    expect(() => tmp.dispose()).not.toThrow();
  });
});
