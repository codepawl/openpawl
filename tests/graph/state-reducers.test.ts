import { describe, it, expect, vi } from "vitest";

// Mock Annotation to capture reducer configs directly
vi.mock("@langchain/langgraph", () => ({
  Annotation: Object.assign(
    // Annotation<T>(config) — called as function for each field
    <T>(config: { reducer: (l: T, r: T) => T; default: () => T }) => config,
    {
      // Annotation.Root(fields) — returns the fields map directly
      Root: (fields: Record<string, unknown>) => fields,
    }
  ),
}));

import { GameStateAnnotation } from "@/core/graph-state.js";

// Type helper to extract reducer from annotation field
type AnnotationField<T> = { reducer: (left: T, right: T) => T; default: () => T };

function field<T>(name: string): AnnotationField<T> {
  return (GameStateAnnotation as Record<string, unknown>)[name] as AnnotationField<T>;
}

describe("GameStateAnnotation reducers", () => {
  describe("lastValue fields", () => {
    it("cycle_count: right value replaces left", () => {
      const f = field<number>("cycle_count");
      expect(f.reducer(3, 5)).toBe(5);
      expect(f.default()).toBe(0);
    });

    it("session_active defaults to true", () => {
      const f = field<boolean>("session_active");
      expect(f.default()).toBe(true);
      expect(f.reducer(true, false)).toBe(false);
    });

    it("user_goal defaults to null", () => {
      const f = field<string | null>("user_goal");
      expect(f.default()).toBeNull();
    });

    it("planning_document defaults to null", () => {
      const f = field<string | null>("planning_document");
      expect(f.default()).toBeNull();
    });

    it("aborted defaults to false", () => {
      const f = field<boolean>("aborted");
      expect(f.default()).toBe(false);
    });

    it("last_action defaults to empty string", () => {
      const f = field<string>("last_action");
      expect(f.default()).toBe("");
      expect(f.reducer("old", "new")).toBe("new");
    });

    it("deep_work_mode defaults to false", () => {
      const f = field<boolean>("deep_work_mode");
      expect(f.default()).toBe(false);
    });

    it("__node__ defaults to null", () => {
      const f = field<string | null>("__node__");
      expect(f.default()).toBeNull();
      expect(f.reducer(null, "coordinator")).toBe("coordinator");
    });

    it("replanning_count defaults to 0", () => {
      const f = field<number>("replanning_count");
      expect(f.default()).toBe(0);
      expect(f.reducer(1, 2)).toBe(2);
    });
  });

  describe("concat reducers", () => {
    it("messages: concatenates arrays", () => {
      const f = field<string[]>("messages");
      expect(f.reducer(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
      expect(f.default()).toEqual([]);
    });

    it("messages: wraps single value in array", () => {
      const f = field<string[]>("messages");
      // The reducer handles non-array right values by wrapping
      expect(f.reducer(["a"], "b" as unknown as string[])).toEqual(["a", "b"]);
    });

    it("agent_messages: concatenates records", () => {
      const f = field<Record<string, unknown>[]>("agent_messages");
      const m1 = { role: "worker", text: "done" };
      const m2 = { role: "coordinator", text: "ack" };
      expect(f.reducer([m1], [m2])).toEqual([m1, m2]);
      expect(f.default()).toEqual([]);
    });

    it("confidence_history: appends records", () => {
      const f = field<Record<string, unknown>[]>("confidence_history");
      const r1 = { score: 0.8 };
      const r2 = { score: 0.9 };
      expect(f.reducer([r1], [r2])).toEqual([r1, r2]);
    });

    it("next_sprint_backlog: accumulates across cycles", () => {
      const f = field<Record<string, unknown>[]>("next_sprint_backlog");
      const t1 = { task_id: "t1" };
      const t2 = { task_id: "t2" };
      expect(f.reducer([t1], [t2])).toEqual([t1, t2]);
    });

    it("new_success_patterns: concatenates strings", () => {
      const f = field<string[]>("new_success_patterns");
      expect(f.reducer(["pattern-a"], ["pattern-b"])).toEqual(["pattern-a", "pattern-b"]);
      expect(f.default()).toEqual([]);
    });

    it("routing_decisions: concatenates arrays", () => {
      const f = field<Record<string, unknown>[]>("routing_decisions");
      const d1 = { agent: "coder", task: "t1" };
      const d2 = { agent: "tester", task: "t2" };
      expect(f.reducer([d1], [d2])).toEqual([d1, d2]);
    });

    it("promoted_this_run: concatenates strings", () => {
      const f = field<string[]>("promoted_this_run");
      expect(f.reducer(["p1"], ["p2"])).toEqual(["p1", "p2"]);
    });

    it("profile_alerts: concatenates arrays", () => {
      const f = field<Record<string, unknown>[]>("profile_alerts");
      expect(f.reducer([{ alert: "a" }], [{ alert: "b" }])).toEqual([
        { alert: "a" },
        { alert: "b" },
      ]);
    });

    it("concat reducer handles empty left", () => {
      const f = field<string[]>("messages");
      expect(f.reducer([], ["first"])).toEqual(["first"]);
    });

    it("concat reducer handles empty right", () => {
      const f = field<string[]>("messages");
      expect(f.reducer(["existing"], [])).toEqual(["existing"]);
    });
  });

  describe("task_queue reducer — merge by task_id", () => {
    it("deduplicates tasks with same task_id", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      const left = [{ task_id: "t1", status: "pending" }];
      const right = [{ task_id: "t1", status: "completed" }];
      const result = f.reducer(left, right);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ task_id: "t1", status: "completed" });
    });

    it("preserves tasks with different task_ids", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      const left = [{ task_id: "t1", status: "pending" }];
      const right = [{ task_id: "t2", status: "pending" }];
      const result = f.reducer(left, right);
      expect(result).toHaveLength(2);
    });

    it("handles empty left array", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      const result = f.reducer([], [{ task_id: "t1" }]);
      expect(result).toHaveLength(1);
    });

    it("handles empty right array", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      const result = f.reducer([{ task_id: "t1" }], []);
      expect(result).toHaveLength(1);
    });

    it("multiple updates to same task keep latest", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      let queue = f.reducer([], [{ task_id: "t1", status: "pending" }]);
      queue = f.reducer(queue, [{ task_id: "t1", status: "in_progress" }]);
      queue = f.reducer(queue, [{ task_id: "t1", status: "completed" }]);
      expect(queue).toHaveLength(1);
      expect(queue[0]!.status).toBe("completed");
    });

    it("drops items without task_id", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      // Items without task_id have falsy id, so the `if (id)` guard skips them
      const result = f.reducer([], [{ name: "no-id" }]);
      expect(result).toHaveLength(0);
    });

    it("mixed: items with and without task_id", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      const result = f.reducer(
        [{ task_id: "t1", status: "pending" }],
        [{ name: "orphan" }, { task_id: "t2", status: "new" }]
      );
      // Only t1 and t2 survive; orphan is dropped
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.task_id)).toEqual(["t1", "t2"]);
    });

    it("defaults to empty array", () => {
      const f = field<Record<string, unknown>[]>("task_queue");
      expect(f.default()).toEqual([]);
    });
  });

  describe("bot_stats reducer — numeric accumulation", () => {
    it("sums numeric values for same bot", () => {
      const f = field<Record<string, Record<string, unknown>>>("bot_stats");
      const left = { "worker-1": { tasks_completed: 2, tokens_used: 100 } };
      const right = { "worker-1": { tasks_completed: 1, tokens_used: 50 } };
      const result = f.reducer(left, right);
      expect(result["worker-1"]!.tasks_completed).toBe(3);
      expect(result["worker-1"]!.tokens_used).toBe(150);
    });

    it("replaces non-numeric values for same bot", () => {
      const f = field<Record<string, Record<string, unknown>>>("bot_stats");
      const left = { "worker-1": { status: "idle", tasks_completed: 1 } };
      const right = { "worker-1": { status: "busy", tasks_completed: 2 } };
      const result = f.reducer(left, right);
      expect(result["worker-1"]!.status).toBe("busy");
      expect(result["worker-1"]!.tasks_completed).toBe(3);
    });

    it("adds new bot entries without affecting existing", () => {
      const f = field<Record<string, Record<string, unknown>>>("bot_stats");
      const left = { "worker-1": { tasks_completed: 5 } };
      const right = { "worker-2": { tasks_completed: 3 } };
      const result = f.reducer(left, right);
      expect(result["worker-1"]!.tasks_completed).toBe(5);
      expect(result["worker-2"]!.tasks_completed).toBe(3);
    });

    it("does not mutate left input", () => {
      const f = field<Record<string, Record<string, unknown>>>("bot_stats");
      const left = { "worker-1": { tasks_completed: 2 } };
      const leftCopy = JSON.parse(JSON.stringify(left));
      f.reducer(left, { "worker-1": { tasks_completed: 1 } });
      expect(left).toEqual(leftCopy);
    });

    it("handles numeric + non-numeric mismatch (left number, right string)", () => {
      const f = field<Record<string, Record<string, unknown>>>("bot_stats");
      const left = { "worker-1": { score: 10 } };
      const right = { "worker-1": { score: "reset" } };
      const result = f.reducer(left, right);
      // typeof right val is string, not number → replace, not sum
      expect(result["worker-1"]!.score).toBe("reset");
    });

    it("handles new keys introduced by right side", () => {
      const f = field<Record<string, Record<string, unknown>>>("bot_stats");
      const left = { "worker-1": { tasks_completed: 1 } };
      const right = { "worker-1": { errors: 2 } };
      const result = f.reducer(left, right);
      expect(result["worker-1"]!.tasks_completed).toBe(1);
      expect(result["worker-1"]!.errors).toBe(2);
    });

    it("defaults to empty object", () => {
      const f = field<Record<string, Record<string, unknown>>>("bot_stats");
      expect(f.default()).toEqual({});
    });
  });
});
