/* eslint-disable @typescript-eslint/no-explicit-any */

type WsSendFn = (data: string) => unknown;

const clients: Set<WsSendFn> = new Set();

const stdoutOriginal = process.stdout.write as (chunk: any, ...args: any[]) => boolean;
const stderrOriginal = process.stderr.write as (chunk: any, ...args: any[]) => boolean;

const BATCH_INTERVAL_MS = 50;
const buffer: string[] = [];
let broadcastScheduled = false;

function flushBuffer(): void {
  if (buffer.length === 0) {
    broadcastScheduled = false;
    return;
  }
  const data = buffer.join("");
  buffer.length = 0;
  broadcastScheduled = false;
  
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: "terminal_out", payload: { data } });
  for (const send of clients) {
    try {
      send(payload);
    } catch {
      // ignore send errors
    }
  }
}

function scheduleBroadcast(): void {
  if (broadcastScheduled) return;
  broadcastScheduled = true;
  setTimeout(flushBuffer, BATCH_INTERVAL_MS);
}

function broadcastToClients(data: string): void {
  if (clients.size === 0) return;
  buffer.push(data);
  scheduleBroadcast();
}

function makeInterceptor(
  original: (chunk: any, ...args: any[]) => boolean
): (chunk: any, ...args: any[]) => boolean {
  return function (chunk, ...args): boolean {
    const result = original(chunk, ...args);
    const str = typeof chunk === "string" ? chunk : String(chunk);
    if (str) {
      broadcastToClients(str);
    }
    return result;
  };
}

export function addTerminalClient(sendFn: WsSendFn): void {
  clients.add(sendFn);
}

export function removeTerminalClient(sendFn: WsSendFn): void {
  clients.delete(sendFn);
}

export function initTerminalBroadcast(): void {
  process.stdout.write = makeInterceptor(stdoutOriginal);
  process.stderr.write = makeInterceptor(stderrOriginal);
}

export function restoreTerminal(): void {
  process.stdout.write = stdoutOriginal;
  process.stderr.write = stderrOriginal;
}

export function broadcastTerminalData(data: string): void {
  broadcastToClients(data);
}

export function flushTerminalBuffer(): void {
  if (broadcastScheduled) {
    flushBuffer();
  }
}
