import path from "node:path";

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/**
 * Resolve a user/agent-supplied path safely within `workspaceDir`.
 *
 * Rules:
 * - Treat `workspaceDir` as the virtual root (/).
 * - Accept absolute-like paths ("/foo") by mapping them into the workspace.
 * - Block traversal attempts that escape the workspace.
 */
export function resolveSafePath(filename: string, workspaceDir: string): string {
  const workspaceAbs = path.resolve(process.cwd(), workspaceDir);
  const raw = filename.trim();
  const agentPath = raw.startsWith("/") ? raw.replace(/^\/+/, "") : raw;
  const candidateAbs = path.resolve(workspaceAbs, agentPath);

  const rel = path.relative(workspaceAbs, candidateAbs);
  const escapes =
    rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

  if (escapes) {
    throw new SecurityError(
      "Path traversal attempt blocked. You are confined to the workspace."
    );
  }
  return candidateAbs;
}

