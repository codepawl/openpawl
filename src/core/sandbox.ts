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
 * - If the path is absolute and already inside the workspace, use it directly
 *   (avoids strip-and-rejoin roundtrip that can create duplicate nested dirs).
 * - Relative paths are joined with workspaceDir.
 * - Absolute paths outside the workspace are mapped in via prefix stripping.
 * - Block traversal attempts that escape the workspace.
 */
export function resolveSafePath(filename: string, workspaceDir: string): string {
  const workspaceAbs = path.isAbsolute(workspaceDir)
    ? workspaceDir
    : path.resolve(process.cwd(), workspaceDir);
  const raw = filename.trim();

  // Fast path: absolute path already inside the workspace — use directly.
  // This avoids the strip-and-rejoin roundtrip that can create nested dirs.
  if (raw.startsWith(workspaceAbs + "/") || raw === workspaceAbs) {
    const normalized = path.normalize(raw);
    const rel = path.relative(workspaceAbs, normalized);
    const escapes =
      rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (!escapes) return normalized;
  }

  // Slow path: strip prefixes and resolve relative to workspace
  const agentPath = stripWorkspacePrefix(raw, workspaceDir);
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

