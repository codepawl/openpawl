import WebSocket from "ws";

export interface OpenAIApiDiscovery {
  baseUrl: string;
  port: number;
  protocol: "http" | "ws";
  serviceName: string;
  chatEndpoint: string;
  models: string[];
}

export interface OpenAIApiDiscoveryOptions {
  preferredPort?: number;
  candidatePorts?: number[];
  timeoutMs?: number;
}

function normalizeBaseHost(baseHost: string): { protocol: string; hostname: string } {
  const withProtocol = baseHost.includes("://") ? baseHost : `http://${baseHost}`;
  const parsed = new URL(withProtocol);
  return { protocol: parsed.protocol, hostname: parsed.hostname };
}

function uniquePorts(ports: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const p of ports) {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function inferHttpServiceName(port: number, serverHeader: string): string {
  const h = serverHeader.toLowerCase();
  if (h.includes("ollama") || port === 11434) return "Ollama";
  if (h.includes("openclaw")) return "OpenClaw";
  return "OpenAI-Compatible";
}

function inferWsServiceName(port: number, htmlSignature: string): string {
  const sig = htmlSignature.toLowerCase();
  if (sig.includes("openclaw") || port === 8001) return "OpenClaw";
  return "WebSocket AI Gateway";
}

async function probeHttpModels(
  workerUrl: string,
  timeoutMs: number
): Promise<{ models: string[]; serverHeader: string } | null> {
  const url = `${workerUrl}/v1/models`;
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) return null;
  const data = (await res.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ id?: string; name?: string }>;
  };
  const fromData =
    data.data
      ?.map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
      .filter((x) => x.length > 0) ?? [];
  const fromModels =
    data.models
      ?.map((m) => {
        const id = typeof m.id === "string" ? m.id.trim() : "";
        const name = typeof m.name === "string" ? m.name.trim() : "";
        return id || name;
      })
      .filter((x) => x.length > 0) ?? [];
  const models = Array.from(new Set([...fromData, ...fromModels]));
  if (models.length === 0) return null;
  return {
    models,
    serverHeader: res.headers.get("server") ?? "",
  };
}

async function probeHtmlSignature(workerUrl: string, timeoutMs: number): Promise<string | null> {
  const res = await fetch(workerUrl, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const text = await res.text();
  const isHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(text);
  if (!isHtml) return null;
  return text.slice(0, 4000);
}

async function probeWebSocket(
  wsUrl: string,
  timeoutMs: number
): Promise<{ opened: boolean; handshakeStatus?: number; isWebSocket: boolean }> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    const timer = setTimeout(() => {
      finish({ opened: false, isWebSocket: false });
    }, timeoutMs);
    // Do not keep the process alive just for a probe timeout.
    timer.unref();

    // Do not keep the process alive just for probe socket I/O.
    const rawSocket = (ws as unknown as { _socket?: { unref?: () => void } })._socket;
    rawSocket?.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      // Keep a no-op error handler while closing to avoid unhandled "error"
      // when ws emits during transitional states.
      ws.on("error", () => {});
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
    };

    const finish = (result: { opened: boolean; handshakeStatus?: number; isWebSocket: boolean }) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    ws.on("open", () => {
      finish({ opened: true, isWebSocket: true });
    });

    ws.on("unexpected-response", (_req, res) => {
      const status = typeof res.statusCode === "number" ? res.statusCode : undefined;
      // 401/403/426 strongly indicates a WS-capable gateway requiring auth/upgrade.
      const wsCapable = status === 401 || status === 403 || status === 426;
      finish({
        opened: false,
        handshakeStatus: status,
        isWebSocket: wsCapable,
      });
    });

    ws.on("error", (err) => {
      const msg = String((err as Error)?.message ?? err).toLowerCase();
      const m = /unexpected server response:\s*(\d+)/i.exec(msg);
      const status = m ? Number(m[1]) : undefined;
      const wsCapable = status === 401 || status === 403 || status === 426;
      finish({
        opened: false,
        handshakeStatus: status,
        isWebSocket: wsCapable,
      });
    });
  });
}

export async function discoverOpenAIApi(
  baseHost = "http://localhost",
  options: OpenAIApiDiscoveryOptions = {}
): Promise<OpenAIApiDiscovery[]> {
  const { protocol, hostname } = normalizeBaseHost(baseHost);
  const defaultCandidates = [8000, 11434, 1234, 8080, 8001];
  const candidates = uniquePorts([
    options.preferredPort ?? Number.NaN,
    ...(options.candidatePorts ?? []),
    ...defaultCandidates,
  ]);
  const timeoutMs = options.timeoutMs ?? 1000;

  const scanPort = async (port: number): Promise<OpenAIApiDiscovery[]> => {
    const workerUrl = `${protocol}//${hostname}:${port}`;
    const wsUrl = `${protocol === "https:" ? "wss" : "ws"}://${hostname}:${port}`;
    const results: OpenAIApiDiscovery[] = [];

    // Probe A: HTTP /v1/models
    try {
      const http = await probeHttpModels(workerUrl, timeoutMs);
      if (http) {
        results.push({
          baseUrl: workerUrl,
          port,
          protocol: "http",
          serviceName: inferHttpServiceName(port, http.serverHeader),
          chatEndpoint: "/v1/chat/completions",
          models: http.models,
        });
      }
    } catch {
      // continue probing
    }

    // Probe B + C: HTML signature + WS handshake
    let htmlSig = "";
    try {
      htmlSig = (await probeHtmlSignature(workerUrl, timeoutMs)) ?? "";
    } catch {
      // ignore
    }
    const ws = await probeWebSocket(wsUrl, timeoutMs).catch(
      () => ({ opened: false, isWebSocket: false } as const)
    );
    const looksOpenClawHtml = htmlSig.toLowerCase().includes("openclaw");
    const shouldAddWs = ws.opened || ws.isWebSocket || looksOpenClawHtml;
    if (shouldAddWs) {
      results.push({
        baseUrl: wsUrl,
        port,
        protocol: "ws",
        serviceName: inferWsServiceName(port, htmlSig),
        chatEndpoint: "/v1/chat/completions",
        models: [],
      });
    }

    return results;
  };

  const settled = await Promise.allSettled(candidates.map((port) => scanPort(port)));
  const discovered: OpenAIApiDiscovery[] = [];
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    discovered.push(...item.value);
  }
  discovered.sort((a, b) => {
    if (a.port !== b.port) return a.port - b.port;
    if (a.protocol === b.protocol) return 0;
    return a.protocol === "http" ? -1 : 1;
  });
  return discovered;
}

