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
  const workspaceAbs = path.isAbsolute(workspaceDir)
    ? workspaceDir
    : path.resolve(process.cwd(), workspaceDir);
  const raw = filename.trim();
  let agentPath = raw.startsWith("/") ? raw.replace(/^\/+/, "") : raw;

  // Strip workspace absolute prefix if agent echoed the full path.
  // e.g. "/home/user/project/src/file.ts" → "src/file.ts"
  const workspacePrefix = workspaceAbs.replace(/^\/+/, "");
  if (agentPath.startsWith(workspacePrefix + "/")) {
    agentPath = agentPath.slice(workspacePrefix.length + 1);
  } else if (agentPath.startsWith(workspacePrefix)) {
    agentPath = agentPath.slice(workspacePrefix.length);
  }

  // Strip workspace basename prefix if agent prepended the project folder.
  // e.g. "my-project/src/file.ts" → "src/file.ts"
  const baseName = path.basename(workspaceAbs);
  if (baseName && agentPath.startsWith(baseName + "/")) {
    agentPath = agentPath.slice(baseName.length + 1);
  }

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

