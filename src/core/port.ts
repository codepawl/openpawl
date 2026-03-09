import net from "node:net";

function canBindPort(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

export async function findAvailablePort(startingPort: number, maxOffset = 10): Promise<number> {
  const base = Number.isInteger(startingPort) && startingPort > 0 ? startingPort : 8000;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const port = base + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${base}-${base + maxOffset}`);
}

