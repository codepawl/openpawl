/**
 * Gateway management has moved out of TeamClaw.
 * TeamClaw now relies directly on OpenClaw for all LLM traffic.
 */

export interface GatewayOptions {
  port?: number;
  configPath?: string;
  host?: string;
}

export async function runGateway(_options: GatewayOptions = {}): Promise<void> {
  throw new Error(
    "Gateway command removed: TeamClaw requires an external OpenClaw gateway (OPENCLAW_WORKER_URL).",
  );
}
