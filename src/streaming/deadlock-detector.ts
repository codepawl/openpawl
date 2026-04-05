/**
 * Circular dependency detection for agent dispatch.
 */

import type { AgentAssignment } from "../router/router-types.js";

export type DeadlockResult =
  | { deadlock: false }
  | { deadlock: true; cycle: string[]; suggestion: string };

export class DeadlockDetector {
  detect(assignments: AgentAssignment[]): DeadlockResult {
    // Build adjacency list
    const graph = new Map<string, string[]>();
    for (const a of assignments) {
      graph.set(a.agentId, a.dependsOn ?? []);
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const path: string[] = [];

    for (const node of graph.keys()) {
      const cycle = this.dfs(node, graph, visited, inStack, path);
      if (cycle) {
        return {
          deadlock: true,
          cycle,
          suggestion: `Break cycle by running ${cycle[cycle.length - 1]} without waiting for ${cycle[0]}`,
        };
      }
    }

    return { deadlock: false };
  }

  private dfs(
    node: string,
    graph: Map<string, string[]>,
    visited: Set<string>,
    inStack: Set<string>,
    path: string[],
  ): string[] | null {
    if (inStack.has(node)) {
      // Found cycle
      const cycleStart = path.indexOf(node);
      return path.slice(cycleStart).concat(node);
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of graph.get(node) ?? []) {
      const cycle = this.dfs(dep, graph, visited, inStack, path);
      if (cycle) return cycle;
    }

    path.pop();
    inStack.delete(node);
    return null;
  }
}
