import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

/** Start a temporary local HTTP server for OAuth callback. Returns the auth code. */
export function startOAuthCallbackServer(
  port: number,
  path: string,
): { promise: Promise<string>; server: Server } {
  let resolve: (code: string) => void;
  let reject: (err: Error) => void;

  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname === path) {
      const code = url.searchParams.get("code");
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authorization successful!</h2><p>You can close this tab.</p></body></html>");
        resolve(code);
      } else {
        const error = url.searchParams.get("error") ?? "No code received";
        const safeError = error.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Error</h2><p>${safeError}</p></body></html>`);
        reject(new Error(error));
      }
      setTimeout(() => server.close(), 500);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, "127.0.0.1");

  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("OAuth callback timed out (5 minutes)"));
  }, 5 * 60 * 1000);

  promise.finally(() => clearTimeout(timeout));

  return { promise, server };
}
