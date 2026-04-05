/**
 * Keep-alive connection pool for provider APIs.
 */

import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

interface PooledConnection {
  agent: HttpAgent | HttpsAgent;
  lastUsed: number;
  requestCount: number;
}

export class ConnectionPool {
  private pools = new Map<string, PooledConnection>();

  async warm(providerBaseUrl: string): Promise<void> {
    this.getConnection(providerBaseUrl);
  }

  getConnection(providerBaseUrl: string): HttpAgent | HttpsAgent {
    const existing = this.pools.get(providerBaseUrl);
    if (existing) {
      existing.lastUsed = Date.now();
      existing.requestCount++;
      return existing.agent;
    }

    const isHttps = providerBaseUrl.startsWith("https");
    const agent = isHttps
      ? new HttpsAgent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30_000 })
      : new HttpAgent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30_000 });

    this.pools.set(providerBaseUrl, { agent, lastUsed: Date.now(), requestCount: 0 });
    return agent;
  }

  closeAll(): void {
    for (const { agent } of this.pools.values()) {
      agent.destroy();
    }
    this.pools.clear();
  }
}
