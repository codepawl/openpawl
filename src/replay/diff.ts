/**
 * Session comparison — diffs two recorded sessions.
 */

import type { SessionDiff, NodeDiff } from "./types.js";
import { getSession } from "./session-index.js";
import { readRecordingEvents } from "./storage.js";

/** Compare two sessions and produce a diff summary. */
export async function diffSessions(sessionIdA: string, sessionIdB: string): Promise<SessionDiff | null> {
  const a = getSession(sessionIdA);
  const b = getSession(sessionIdB);
  if (!a || !b) return null;

  const eventsA = await readRecordingEvents(sessionIdA);
  const eventsB = await readRecordingEvents(sessionIdB);

  // Extract unique nodes
  const nodesA = new Set(eventsA.filter((e) => e.phase === "exit").map((e) => e.nodeId));
  const nodesB = new Set(eventsB.filter((e) => e.phase === "exit").map((e) => e.nodeId));

  const changedNodes: NodeDiff[] = [];

  // Nodes in B but not A
  for (const node of nodesB) {
    if (!nodesA.has(node)) {
      changedNodes.push({ nodeId: node, changeType: "added", details: "New node in second session" });
    }
  }

  // Nodes in A but not B
  for (const node of nodesA) {
    if (!nodesB.has(node)) {
      changedNodes.push({ nodeId: node, changeType: "removed", details: "Node absent in second session" });
    }
  }

  // Nodes in both — compare outputs
  for (const node of nodesA) {
    if (!nodesB.has(node)) continue;

    const exitA = eventsA.filter((e) => e.nodeId === node && e.phase === "exit");
    const exitB = eventsB.filter((e) => e.nodeId === node && e.phase === "exit");

    // Compare execution counts
    if (exitA.length !== exitB.length) {
      changedNodes.push({
        nodeId: node,
        changeType: "modified",
        details: `Execution count: ${exitA.length} vs ${exitB.length}`,
      });
      continue;
    }

    // Compare last exit confidence
    const lastA = exitA[exitA.length - 1];
    const lastB = exitB[exitB.length - 1];
    if (lastA?.agentOutput?.confidence && lastB?.agentOutput?.confidence) {
      const confA = lastA.agentOutput.confidence.score;
      const confB = lastB.agentOutput.confidence.score;
      if (Math.abs(confA - confB) > 0.05) {
        changedNodes.push({
          nodeId: node,
          changeType: "modified",
          details: `confidence: ${confA.toFixed(2)} → ${confB.toFixed(2)}`,
        });
      }
    }

    // Compare duration
    if (lastA?.durationMs && lastB?.durationMs) {
      const ratio = lastB.durationMs / lastA.durationMs;
      if (ratio > 2 || ratio < 0.5) {
        changedNodes.push({
          nodeId: node,
          changeType: "modified",
          details: `duration: ${lastA.durationMs}ms → ${lastB.durationMs}ms`,
        });
      }
    }
  }

  // Count tasks from last exit states
  const lastStateA = eventsA.filter((e) => e.phase === "exit").pop()?.stateAfter;
  const lastStateB = eventsB.filter((e) => e.phase === "exit").pop()?.stateAfter;
  const taskCountA = Array.isArray(lastStateA?.task_queue) ? (lastStateA.task_queue as unknown[]).length : 0;
  const taskCountB = Array.isArray(lastStateB?.task_queue) ? (lastStateB.task_queue as unknown[]).length : 0;

  return {
    sessionA: sessionIdA,
    sessionB: sessionIdB,
    goalSame: a.goal === b.goal,
    goalA: a.goal,
    goalB: b.goal,
    teamSame: JSON.stringify(a.teamComposition.sort()) === JSON.stringify(b.teamComposition.sort()),
    teamA: a.teamComposition,
    teamB: b.teamComposition,
    taskCountA,
    taskCountB,
    avgConfidenceA: a.averageConfidence,
    avgConfidenceB: b.averageConfidence,
    durationA: a.completedAt - a.createdAt,
    durationB: b.completedAt - b.createdAt,
    changedNodes,
  };
}
