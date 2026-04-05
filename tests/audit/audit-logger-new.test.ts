import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AuditLogger } from "../../src/audit/audit-logger.js";
import type { ToolAuditEntry } from "../../src/audit/tool-audit-types.js";
import { randomUUID } from "node:crypto";

function makeEntry(overrides?: Partial<ToolAuditEntry>): ToolAuditEntry {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: "s1",
    agentId: "coder",
    agentName: "Coder",
    toolName: "file_read",
    toolDisplayName: "Read File",
    category: "file",
    operation: "Read src/auth.ts",
    inputSummary: '{"path":"src/auth.ts"}',
    outputSummary: "Read 148 lines",
    success: true,
    duration: 12,
    permissionLevel: "auto",
    filesModified: [],
    filesRead: ["src/auth.ts"],
    networkRequests: [],
    injectionAlerts: 0,
    chainAlerts: 0,
    ...overrides,
  };
}

describe("AuditLogger", () => {
  let tmpDir: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-audit-test-"));
    logger = new AuditLogger(tmpDir);
  });

  afterEach(async () => {
    await logger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("log appends entry as single JSON line", async () => {
    await logger.log(makeEntry());
    await logger.flush();

    const content = await readFile(path.join(tmpDir, "audit.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it("multiple entries on separate lines", async () => {
    await logger.log(makeEntry());
    await logger.log(makeEntry());
    await logger.log(makeEntry());
    await logger.flush();

    const content = await readFile(path.join(tmpDir, "audit.jsonl"), "utf-8");
    expect(content.trim().split("\n")).toHaveLength(3);
  });

  it("credentials redacted in logged entries", async () => {
    await logger.log(makeEntry({ inputSummary: "key=sk-ant-api03-abcdefghijklmnop" }));
    await logger.flush();

    const content = await readFile(path.join(tmpDir, "audit.jsonl"), "utf-8");
    expect(content).not.toContain("abcdefghijklmnop");
    expect(content).toContain("sk-ant");
  });

  it("close flushes and closes", async () => {
    await logger.log(makeEntry());
    await logger.close();
    expect(existsSync(path.join(tmpDir, "audit.jsonl"))).toBe(true);
  });
});
