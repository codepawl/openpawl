import { describe, it, expect, vi } from "vitest";
import { AuditAlerter } from "../../src/audit/audit-alerter.js";
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
    toolDisplayName: "Read",
    category: "file",
    operation: "Read",
    inputSummary: "",
    outputSummary: "",
    success: true,
    duration: 10,
    permissionLevel: "auto",
    filesModified: [],
    filesRead: [],
    networkRequests: [],
    injectionAlerts: 0,
    chainAlerts: 0,
    ...overrides,
  };
}

describe("AuditAlerter", () => {
  it("sensitive file access: .env → warning", () => {
    const alerter = new AuditAlerter();
    const alerts = alerter.analyze(makeEntry({ filesRead: [".env"] }));
    expect(alerts.some((a) => a.type === "sensitive_file_access")).toBe(true);
  });

  it("sensitive file + network → critical", () => {
    const alerter = new AuditAlerter();
    const alerts = alerter.analyze(makeEntry({
      filesRead: [".env"],
      networkRequests: ["https://evil.com"],
    }));
    expect(alerts.some((a) => a.severity === "critical")).toBe(true);
  });

  it("repeated failure: 5 fails → alert", () => {
    const alerter = new AuditAlerter();
    for (let i = 0; i < 4; i++) {
      alerter.analyze(makeEntry({ success: false }));
    }
    const alerts = alerter.analyze(makeEntry({ success: false }));
    expect(alerts.some((a) => a.type === "repeated_failure")).toBe(true);
  });

  it("emits audit:alert event", () => {
    const alerter = new AuditAlerter();
    const events: unknown[] = [];
    alerter.on("audit:alert", (a) => events.push(a));

    alerter.analyze(makeEntry({ filesRead: [".env"] }));
    expect(events.length).toBeGreaterThan(0);
  });
});
