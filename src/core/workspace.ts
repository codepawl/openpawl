/**
 * Workspace detection and initialization.
 *
 * A workspace is a `.openpawl/` directory in the current working directory.
 * It provides project-local config overrides, agent definitions, and rules.
 * Only created when the user runs `/workspace init`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const WORKSPACE_DIR = ".openpawl";

export interface WorkspaceInfo {
  /** Absolute path to workspace dir (.openpawl/) or null if not initialized. */
  path: string | null;
  /** Absolute path to cwd. */
  cwd: string;
  /** Project name (directory basename). */
  projectName: string;
  /** Whether .openpawl/ exists in cwd. */
  initialized: boolean;
}

/** Get the absolute path to the workspace directory (may not exist). */
export function getWorkspacePath(cwd: string = process.cwd()): string {
  return path.join(cwd, WORKSPACE_DIR);
}

/** Check whether a workspace has been initialized in the given directory. */
export function isWorkspaceInitialized(cwd: string = process.cwd()): boolean {
  return existsSync(getWorkspacePath(cwd));
}

/** Get workspace info for the given directory. */
export function getWorkspaceInfo(cwd: string = process.cwd()): WorkspaceInfo {
  const wsPath = getWorkspacePath(cwd);
  const initialized = existsSync(wsPath);
  return {
    path: initialized ? wsPath : null,
    cwd: path.resolve(cwd),
    projectName: path.basename(path.resolve(cwd)),
    initialized,
  };
}

/** Read .openpawl/rules.md if it exists. Returns null if missing. */
export function getWorkspaceRules(cwd: string = process.cwd()): string | null {
  const rulesPath = path.join(getWorkspacePath(cwd), "rules.md");
  if (!existsSync(rulesPath)) return null;
  try {
    return readFileSync(rulesPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read workspace config (.openpawl/config.json).
 * Returns null if workspace is not initialized or config doesn't exist.
 */
export function readWorkspaceConfig(cwd: string = process.cwd()): Record<string, unknown> | null {
  const configPath = path.join(getWorkspacePath(cwd), "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write workspace config (.openpawl/config.json). */
export function writeWorkspaceConfig(data: Record<string, unknown>, cwd: string = process.cwd()): void {
  const configPath = path.join(getWorkspacePath(cwd), "config.json");
  writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

const RULES_TEMPLATE = `# Workspace Rules
#
# Custom instructions for agents working in this project.
# This content is prepended to every agent's system prompt.
#
# Examples:
# - This project uses Bun, not Node
# - Use Zod for all validation
# - Tests go in tests/ not __tests__/
# - Never modify files in src/legacy/
`;

/**
 * Initialize a workspace in the given directory.
 * Creates .openpawl/ with config.json, rules.md, and agents/.
 * Adds .openpawl/scratch/ to .gitignore if applicable.
 * Returns the absolute path to the workspace directory.
 */
export function initWorkspace(cwd: string = process.cwd()): string {
  const wsPath = getWorkspacePath(cwd);

  if (existsSync(wsPath)) {
    return wsPath; // already initialized
  }

  // Create directory structure
  mkdirSync(wsPath, { recursive: true });
  mkdirSync(path.join(wsPath, "agents"), { recursive: true });
  mkdirSync(path.join(wsPath, "scratch"), { recursive: true });

  // Create config.json
  writeFileSync(
    path.join(wsPath, "config.json"),
    JSON.stringify({ version: 1 }, null, 2) + "\n",
    "utf-8",
  );

  // Create rules.md template
  writeFileSync(path.join(wsPath, "rules.md"), RULES_TEMPLATE, "utf-8");

  // Add scratch/ to .gitignore
  addScratchToGitignore(cwd);

  return wsPath;
}

/** Append .openpawl/scratch/ to .gitignore if in a git repo and not already present. */
function addScratchToGitignore(cwd: string): void {
  // Only if this is a git repo
  if (!existsSync(path.join(cwd, ".git"))) return;

  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = ".openpawl/scratch/";

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(entry)) return; // already present
    appendFileSync(gitignorePath, `\n# OpenPawl workspace scratch (auto-generated)\n${entry}\n`);
  } else {
    writeFileSync(gitignorePath, `# OpenPawl workspace scratch (auto-generated)\n${entry}\n`, "utf-8");
  }
}
