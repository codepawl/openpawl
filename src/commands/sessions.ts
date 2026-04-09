/**
 * CLI command: openpawl sessions
 * Manage interactive chat sessions.
 */

import { logger } from "../core/logger.js";
import { isCancel, confirm } from "@clack/prompts";
import { createSessionManager } from "../session/index.js";

export async function runSessionsCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    logger.plain("Usage: openpawl sessions <subcommand>\n");
    logger.plain("Subcommands:");
    logger.plain("  list               List all sessions");
    logger.plain("  resume <id>        Resume a session");
    logger.plain("  delete <id>        Delete a session");
    logger.plain("  purge              Delete all archived sessions");
    return;
  }

  const manager = createSessionManager();
  await manager.initialize();

  try {
    if (sub === "list") {
      await listSessions(manager, args.slice(1));
    } else if (sub === "resume") {
      await resumeSession(manager, args[1]);
    } else if (sub === "delete") {
      await deleteSession(manager, args[1]);
    } else if (sub === "purge") {
      await purgeSessions(manager);
    } else {
      logger.error(`Unknown subcommand: ${sub}`);
      logger.plain('Run "openpawl sessions --help" for usage.');
    }
  } finally {
    await manager.shutdown();
  }
}

async function listSessions(
  manager: InstanceType<typeof import("../session/index.js").SessionManager>,
  args: string[],
): Promise<void> {
  const statusFilter = args.includes("--archived")
    ? "archived" as const
    : args.includes("--active")
      ? "active" as const
      : undefined;

  const result = await manager.list({
    status: statusFilter,
    sortBy: "updatedAt",
  });

  if (result.isErr()) {
    logger.error(`Failed to list sessions: ${result.error.type}`);
    return;
  }

  const items = result.value;
  if (items.length === 0) {
    logger.plain("No sessions found.");
    return;
  }

  logger.plain("ID            Title                          Updated          Msgs  Status");
  logger.plain("─".repeat(85));

  for (const item of items) {
    const id = item.id.padEnd(14);
    const title = item.title.slice(0, 30).padEnd(31);
    const updated = formatRelative(item.updatedAt).padEnd(17);
    const msgs = String(item.messageCount).padEnd(6);
    const status = item.status;
    logger.plain(`${id}${title}${updated}${msgs}${status}`);
  }
}

async function resumeSession(
  manager: InstanceType<typeof import("../session/index.js").SessionManager>,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) {
    logger.error("Usage: openpawl sessions resume <id>");
    return;
  }

  const result = await manager.resume(sessionId);
  if (result.isErr()) {
    logger.error(`Failed to resume session: ${result.error.type}`);
    return;
  }

  logger.success(`Resumed session ${sessionId}`);
}

async function deleteSession(
  manager: InstanceType<typeof import("../session/index.js").SessionManager>,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) {
    logger.error("Usage: openpawl sessions delete <id>");
    return;
  }

  const canPrompt = Boolean(process.stdout.isTTY && process.stderr.isTTY);
  if (canPrompt) {
    const confirmed = await confirm({
      message: `Permanently delete session ${sessionId}?`,
    });
    if (isCancel(confirmed) || !confirmed) {
      logger.plain("Cancelled.");
      return;
    }
  }

  const result = await manager.delete(sessionId);
  if (result.isErr()) {
    logger.error(`Failed to delete session: ${result.error.type}`);
    return;
  }

  logger.success(`Deleted session ${sessionId}`);
}

async function purgeSessions(
  manager: InstanceType<typeof import("../session/index.js").SessionManager>,
): Promise<void> {
  const canPrompt = Boolean(process.stdout.isTTY && process.stderr.isTTY);
  if (canPrompt) {
    const confirmed = await confirm({
      message: "Permanently delete all archived sessions?",
    });
    if (isCancel(confirmed) || !confirmed) {
      logger.plain("Cancelled.");
      return;
    }
  }

  // Access store via list + delete pattern
  const listResult = await manager.list({ status: "archived" });
  if (listResult.isErr()) {
    logger.error(`Failed to list sessions: ${listResult.error.type}`);
    return;
  }

  let count = 0;
  for (const item of listResult.value) {
    const delResult = await manager.delete(item.id);
    if (delResult.isOk()) count++;
  }

  logger.success(`Purged ${count} archived session${count === 1 ? "" : "s"}.`);
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days > 1 ? "s" : ""} ago`;
  return new Date(iso).toLocaleDateString();
}
