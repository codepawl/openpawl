/**
 * Real-time alerts for suspicious audit patterns.
 */

import { EventEmitter } from "node:events";
import type { ToolAuditEntry as AuditEntry, ToolAuditAlert as AuditAlert } from "./tool-audit-types.js";

const SENSITIVE_PATTERNS = [/\.env/, /\.key$/, /\.pem$/, /\.p12$/, /id_rsa/];
const HIGH_FREQUENCY_THRESHOLD = 20;
const HIGH_FREQUENCY_WINDOW_MS = 5 * 60_000;
const FAILURE_THRESHOLD = 5;

export class AuditAlerter extends EventEmitter {
  private recentEntries: AuditEntry[] = [];
  private failureCounts = new Map<string, number>(); // tool:agent → count

  analyze(entry: AuditEntry, _recentEntries?: AuditEntry[]): AuditAlert[] {
    const alerts: AuditAlert[] = [];

    // Track recent entries (sliding window)
    this.recentEntries.push(entry);
    const cutoff = Date.now() - HIGH_FREQUENCY_WINDOW_MS;
    this.recentEntries = this.recentEntries.filter((e) => new Date(e.timestamp).getTime() > cutoff);

    // High frequency
    if (this.recentEntries.length > HIGH_FREQUENCY_THRESHOLD) {
      alerts.push({
        severity: "warning",
        type: "high_frequency",
        message: `${this.recentEntries.length} tool calls in last 5 minutes`,
        entries: [entry.id],
      });
    }

    // Sensitive file access
    const allFiles = [...entry.filesRead, ...entry.filesModified];
    for (const file of allFiles) {
      if (SENSITIVE_PATTERNS.some((p) => p.test(file))) {
        // Check if followed by network tool
        const hasNetwork = entry.networkRequests.length > 0;
        alerts.push({
          severity: hasNetwork ? "critical" : "warning",
          type: "sensitive_file_access",
          message: `Sensitive file accessed: ${file}${hasNetwork ? " + network request" : ""}`,
          entries: [entry.id],
        });
      }
    }

    // Repeated failure
    if (!entry.success) {
      const key = `${entry.toolName}:${entry.agentId}`;
      const count = (this.failureCounts.get(key) ?? 0) + 1;
      this.failureCounts.set(key, count);
      if (count >= FAILURE_THRESHOLD) {
        alerts.push({
          severity: "warning",
          type: "repeated_failure",
          message: `${entry.toolName} failed ${count} times for ${entry.agentId}`,
          entries: [entry.id],
        });
      }
    } else {
      // Reset failure count on success
      this.failureCounts.delete(`${entry.toolName}:${entry.agentId}`);
    }

    for (const alert of alerts) {
      this.emit("audit:alert", alert);
    }

    return alerts;
  }
}
