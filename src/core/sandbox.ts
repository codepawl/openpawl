import path from "node:path";

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/**
 * Strip workspace-absolute or basename prefixes from an agent-supplied path
 * so it becomes relative to `workspaceDir`.
 *
 * Handles:
 * - Leading slashes: "/foo" → "foo"
 * - Full workspace prefix: "/home/user/project/src/file.ts" → "src/file.ts"
 * - Basename prefix: "my-project/src/file.ts" → "src/file.ts"
 */
export function stripWorkspacePrefix(raw: string, workspaceDir: string): string {
  const workspaceAbs = path.isAbsolute(workspaceDir)
    ? workspaceDir
    : path.resolve(process.cwd(), workspaceDir);

  let agentPath = raw.startsWith("/") ? raw.replace(/^\/+/, "") : raw;

  // Strip workspace absolute prefix if agent echoed the full path.
  const workspacePrefix = workspaceAbs.replace(/^\/+/, "");
  if (agentPath.startsWith(workspacePrefix + "/")) {
    agentPath = agentPath.slice(workspacePrefix.length + 1);
  } else if (agentPath.startsWith(workspacePrefix)) {
    agentPath = agentPath.slice(workspacePrefix.length);
  }

  // Strip workspace basename prefix if agent prepended the project folder.
  const baseName = path.basename(workspaceAbs);
  if (baseName && agentPath.startsWith(baseName + "/")) {
    agentPath = agentPath.slice(baseName.length + 1);
  }

  return agentPath;
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

  const agentPath = stripWorkspacePrefix(filename.trim(), workspaceDir);
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

