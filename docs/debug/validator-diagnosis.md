# Validator false-positive diagnosis

Source log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-fix2.jsonl` (1,606 events).

## Per-task findings

### task-1 — planner, "Initialize TypeScript project: create package.json, install TypeScript and chalk…"

- Attempt 1 (12:32:38 → 12:33:17, 39s): tool:result_detail events in window = **0**. Agent made `file_list`, failed `file_read`, and a failed MCP call to `cli-task-manager`. Never invoked `file_write`, `file_edit`, or a successful `shell_exec`.
- Attempt 2 (12:33:17 → 12:34:51, 94s): same pattern — more file_list/file_read failures, one more MCP attempt, no write tools.
- **Verdict:** not a race. Planner agent genuinely cannot complete a "create package.json" task — planner's `defaultTools` are `["file_read", "file_list", "web_search"]` (see `src/router/agent-registry.ts:65`). No write tool in its kit. This is an **agent-assignment issue**, not a validator bug. Flagged correctly as incomplete; retry with same planner cannot help. The classifier sees this as `kind: "unknown"` and still retries.

### task-2 — planner, "Define Task interface with fields…"

- Attempt 1 (12:34:51 → 12:35:14, 23s): zero write events.
- Attempt 2 (12:35:14 → 12:35:35, 20s): completed. Log shows a `file_write` occurred in that window at 12:35:21 — the retry succeeded because the agent used a different tool path the second time (or the race flipped in the right direction).
- **Verdict:** mixed. Same planner-misassignment as task-1, but the retry happened to succeed.

### task-3 — coder, "Implement JSON file persistence in src/storage.ts…"  ← **THE SMOKING GUN**

- Attempt 1 ran in **parallel with task-5** (both started at 12:35:35.095Z). Window 12:35:35 → 12:36:01.
- In that window: **2 `file_write` events (12:35:56, 12:35:59)** + 13 `shell_exec` events.
- task-5 completed successfully. task-3 completed `incomplete` ("agent only performed read operations").
- Only two parallel tasks running. Two writes observed. One of the writes *must* belong to task-3, but task-3's `toolsCalled` never saw it.
- Attempt 2 (retry) ran alone, completed successfully.
- **Verdict:** clear parallel-attribution race. The writes happened, the validator didn't see them on task-3 because `recordToolCall` was attributing to `state.currentTaskIndex`, which had been clobbered by whichever of task-3/task-5 most recently entered `executeTask`.

### task-6 — coder, "Build CLI parser in src/cli.ts…"

- Attempt 1 ran in parallel with task-8 (started in the same round).
- Similar attribution pattern; multiple write events in the shared window but task-6 flagged incomplete. task-6 succeeded on solo retry.
- **Verdict:** same parallel race as task-3.

### task-7 — coder, "Create src/index.ts main entry…"

- Attempt 1 ran in parallel with task-9.
- Flagged incomplete; succeeded on solo retry.
- **Verdict:** same parallel race.

## Tally

| task   | agent   | parallel peer | outcome        | root cause                        |
|--------|---------|---------------|----------------|-----------------------------------|
| task-1 | planner | —             | never succeeded| agent misassignment (planner lacks write tools) |
| task-2 | planner | —             | succeeded on retry | agent misassignment; retry race-lucky |
| task-3 | coder   | task-5        | succeeded on retry | **parallel attribution race** |
| task-6 | coder   | task-8        | succeeded on retry | **parallel attribution race** |
| task-7 | coder   | task-9        | succeeded on retry | **parallel attribution race** |

## Hypothesis check against user's list

- **(a) "toolsCalled list gets cleared/overwritten between turns"** — Refined form **TRUE** for parallel execution. `this.state.currentTaskIndex` is a single shared slot; `executeTask` overwrites it on entry at `src/sprint/sprint-runner.ts:463`. `recordToolCall` at `:612-621` reads that shared slot. Under parallel execution (up to `maxConcurrency=3` from `src/sprint/sprint-runner.ts:428-431`), tool calls from one task get attributed to whichever task most recently ran `executeTask`'s entry line. This is the root cause for tasks 3, 6, 7.
- **(b) "Only last turn's tool calls captured"** — FALSE. The `toolsCalled` array is `task.toolsCalled.push(toolName)` (deduped by `includes`), so multiple turns within one task accumulate correctly. The bug is across parallel tasks, not across turns.
- **(c) "taskExpectsWrite is too aggressive"** — FALSE for the parallel-race tasks; their descriptions ("Implement", "Build", "Create") are unambiguously write-intent. Partial truth for task-1/task-2 (the planner-assignment issue) but loosening keywords wouldn't help planner do file_write when it has no file_write tool.
- **(d) "Success flag interpretation wrong"** — FALSE. `taskDidWrite` at `src/sprint/sprint-runner.ts:585-587` only checks tool *names* in `WRITE_TOOLS`, not exit codes or success flags.

## Fix target

Thread an explicit `taskIndex` through the agent-runner boundary so `recordToolCall` attributes to the task whose `executeTask` frame spawned the call, not to a shared mutable slot. Leaves `state.currentTaskIndex` intact as a fallback (used by `retryTask` and similar sequential-state consumers).

Scope does **not** address the task-1/task-2 planner-assignment issue — that's a separate bug (planner being assigned write-intent tasks) and out of the current patch's scope. Even after this fix, task-1 may still fail, but it will fail *correctly*: the planner really didn't write, and that's accurate.

## Artifact references

- Retry gate events: `jq -c 'select(.event=="sprint:retry_gate")' cli-task-manager-sprint-post-fix2.jsonl` → 5 entries, all `kind: "unknown"`.
- Parallel write window for task-3/task-5: events at 12:35:35 through 12:36:01.
- Full fix2-validation context: `docs/debug/fix2-validation.md`.
