/**
 * Block known malicious domains for agent web requests.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const BUILT_IN_BLOCKLIST = new Set([
  "evil.com",
  "malware.example",
]);

export class DnsFilter {
  private blocklist = new Set(BUILT_IN_BLOCKLIST);

  async loadBlocklist(userBlocklistPath?: string): Promise<void> {
    if (!userBlocklistPath || !existsSync(userBlocklistPath)) return;
    try {
      const content = await readFile(userBlocklistPath, "utf-8");
      for (const line of content.split("\n")) {
        const domain = line.trim();
        if (domain && !domain.startsWith("#")) this.blocklist.add(domain.toLowerCase());
      }
    } catch { /* skip */ }
  }

  isBlocked(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    if (this.blocklist.has(lower)) return true;
    // Check parent domains
    const parts = lower.split(".");
    for (let i = 1; i < parts.length; i++) {
      if (this.blocklist.has(parts.slice(i).join("."))) return true;
    }
    return false;
  }

  addBlock(hostname: string): void {
    this.blocklist.add(hostname.toLowerCase());
  }
}
