/**
 * Permission resolver — checks and tracks tool permissions per session.
 */

import type { PermissionLevel, RiskLevel, PermissionCheckResult } from "./types.js";

export class PermissionResolver {
  private sessionGrants = new Set<string>();

  checkPermission(
    toolName: string,
    _agentId: string,
    resolvedPermission: PermissionLevel,
    riskLevel: RiskLevel = "moderate",
  ): PermissionCheckResult {
    if (resolvedPermission === "block") {
      return { allowed: false, reason: "blocked" };
    }

    if (resolvedPermission === "auto") {
      return { allowed: true };
    }

    if (resolvedPermission === "session") {
      if (this.sessionGrants.has(toolName)) {
        return { allowed: true };
      }
      return {
        needsConfirmation: true,
        risk: riskLevel,
        description: `Tool "${toolName}" requires one-time session approval`,
      };
    }

    // "confirm" — always ask
    return {
      needsConfirmation: true,
      risk: riskLevel,
      description: `Tool "${toolName}" requires confirmation before each use`,
    };
  }

  grantSession(toolName: string): void {
    this.sessionGrants.add(toolName);
  }

  recordRejection(_toolName: string, _agentId: string): void {
    // Could track rejections for analytics, no-op for now
  }

  resetSession(): void {
    this.sessionGrants.clear();
  }
}
