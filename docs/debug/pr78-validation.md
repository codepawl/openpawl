# PR #78 validation — validator parallel-race fix

Post-fix sprint rerun: `cli-task-manager`, sprint mode, 1 run, `OPENPAWL_DEBUG=true` + `OPENPAWL_PROFILE=true`, built `dist/` at `fix/validation-parallel-race` tip (contains PRs #76 + #77 + the #78 patch).

- Debug log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-pr78.jsonl`.
- Parent log: `benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run5-pr78.jsonl`.

## Headline

**The validator race is fixed.** Retries dropped from 5 → **0**. Tasks completed 9/9 on first try. Output tokens dropped 69 % (34,630 → 10,557). Wall time dropped 56 % (9m 14s → 4m 2s).

## 1. Comparison: post-PR-77 vs post-PR-78

| metric                           | post-PR #77 (fix2)   | post-PR #78           | delta            |
|----------------------------------|----------------------|-----------------------|------------------|
| Wall time                        | 9m 14s               | **4m 2s**             | **−56 %**        |
| LLM calls                        | 121                  | **91**                | −25 %            |
| Input tokens                     | 86,815               | **38,790**            | **−55 %**        |
| **Output tokens**                | 34,630               | **10,557**            | **−69 %**        |
| Files produced (incl. compiled)  | 14                   | 9                     | −36 %            |
| Source files (src/\*.ts)         | ~9                   | **3**                 | −67 %            |
| LOC (source only)                | ~700                 | 147                   | −79 %            |
| `sprint:task_retry` events       | 5                    | **0**                 | **−100 %**       |
| `sprint:retry_gate` events       | 5                    | **0**                 | **−100 %**       |
| Tasks completed on first try     | 4/9                  | **9/9**               |                  |
| Tasks marked `incomplete`        | 5                    | **0**                 | **−100 %**       |
| `BLOCKED:` emissions             | 0                    | 0                     | —                |

Source count for post-PR-77 approximated from the 14 total files at that run's workdir (which included multiple duplicates — the agents wrote to both repo root and `src/`).

## 2. Per-task outcome

All 9 tasks assigned to `coder` except task-9 (tester). 0 retries. All completed cleanly.

| taskId  | agent  | first-try status | tool calls observed (completed) | retry? |
|---------|--------|------------------|----------------------------------|--------|
| task-1  | coder  | completed        | 6× shell_exec, 2× file_write     | no     |
| task-2  | coder  | completed        | 2× file_list, 6× shell_exec, 2× file_read | no  |
| task-3  | coder  | completed        | 2× file_list, 8× shell_exec, 2× file_write | no |
| task-4  | coder  | completed        | 3× file_read, 1× file_write, 4× shell_exec | no |
| task-5  | coder  | completed        | (parallel batch with 6, 9 — tools interleaved) | no |
| task-6  | coder  | completed        | (parallel batch)                 | no     |
| task-7  | coder  | completed        | —                                | no     |
| task-8  | coder  | completed        | —                                | no     |
| task-9  | tester | completed        | —                                | no     |

The task-5 / task-6 / task-9 parallel batch interleaves tool events in the log; without per-task correlation in the existing event stream, we cannot split them cleanly. What matters for this validation is that none of them was flagged incomplete — the race attribution fix let all three validate correctly against their own tool-call histories.

Per-node breakdown: **not available** on this branch. The source-tagging commit (`de6b595` on `origin/fix/debug-logger-signal-rerun`) that adds `source: "sprint:${agentName}"` to `callLLMMultiTurn` options, and fixes the token-redaction regex, is not on `fix/validation-parallel-race`. All `llm:response` events record `source: null`. Same limitation as §2 of `docs/debug/fix2-validation.md`.

## 3. Sprint / solo ratio update

Solo baseline from `docs/debug/sprint-token-breakdown.md` (3m 9s / 43.1k in / 16.6k out / 17 files / 1,721 LOC).

| metric             | solo (baseline) | sprint post-PR-78 | ratio  | ratio post-PR-77 (for ref) |
|--------------------|-----------------|-------------------|--------|----------------------------|
| LLM calls          | 10              | 91                | 9.1×   | 12.1×                      |
| Input tokens       | 43,133          | 38,790            | **0.90×** | 2.01×                      |
| **Output tokens**  | 16,630          | 10,557            | **0.63×** | 2.08×                      |
| Wall time          | 3m 9s           | 4m 2s             | 1.28×  | 2.93×                      |
| Files produced     | 17              | 9                 | 0.53×  | 0.82×                      |
| LOC produced       | 1,721           | 331 (incl dist)   | 0.19×  | 0.63×                      |

**Sprint now uses fewer tokens than solo** on this task — the first time in the fix series this inversion has happened. Output ratio went from 2.08× (post-PR-77) → 0.63× (post-PR-78), a **3.3× improvement** against solo. Wall ratio improved from 2.93× → 1.28×.

The *cost* side of the sprint/solo tradeoff is now favorable. The *output* side (files/LOC) is still well below solo and dropped further this run — see §5.

## 4. Verdict

### Is the validator race fixed? — **Yes.**

Evidence:
- 0 `sprint:task_retry` events in 1,400+ log lines.
- 0 `sprint:retry_gate` events.
- 0 tasks marked `incomplete`.
- All 9 tasks completed on first try, including task-3, task-6, task-7 (the specific tasks that previously lost to the race).
- Parallel batch (task-5 + task-6 + task-9) executed without any attribution loss.

### Is sprint/solo ratio now favorable? — **Yes for cost, no for output completeness.**

- Output-token ratio: 0.63× (sprint cheaper than solo). Previously 2.08×.
- Wall-time ratio: 1.28× (sprint slower but close). Previously 2.93×.
- Source LOC ratio: 0.19× (sprint produces much less code). Previously 0.63×.

Sprint is now strictly cheaper than solo on this task, but produces roughly 20 % of the source LOC solo produces. The existing quality tradeoff (sprint = less code, more structured) has sharpened.

## 5. Flags for next work

### (a) The planner-agent-misassignment bug did not trigger in this run

The post-PR-77 log had task-1 and task-2 assigned to `planner` (which has no write tools in `defaultTools`), leading to guaranteed incomplete validation regardless of the race. In this run the planner output put all tasks on `coder`, so that bug never got a chance to fire. It remains latent:

- `src/router/agent-registry.ts:63` — planner has `defaultTools: ["file_read", "file_list", "web_search"]`.
- When the LLM planner emits a task with `"agent": "planner"` for a write-intent task (e.g. "create package.json"), the sprint runner will honor that assignment, the planner will have no write tool available, and the task will be flagged incomplete.

This is LLM-output-dependent: the planner happened to route correctly this run. Next run may not. Remediation options:
1. Validate planner output: reject `agent: "planner"` assignments for write-intent task descriptions; downgrade to `coder`.
2. Broaden `planner.defaultTools` to include `file_write`. (Arguable — planners that write files are no longer pure planners.)
3. Warn at assignment time when an agent's `defaultTools` doesn't intersect with the task's expected tools.

Option 1 is minimal-surface and matches the existing heuristic shape.

### (b) Source LOC dropped sharply — possible under-completion

Source files produced: `src/tasks.ts`, `src/storage.ts`, `src/types.ts`, `test-chalk.ts`. **Missing from the planner's task list:** `src/display.ts` (task-5), `src/cli.ts` (task-6), `src/index.ts` (task-7), `src/__tests__/tasks.test.ts` (task-9), and `package.json` was produced but README was not (task-8).

Tasks 5, 6, 7, 8, 9 all marked `completed` in the event stream but their expected output files aren't on disk. The validation heuristic is passing because `shell_exec` is in `WRITE_TOOLS` — any shell invocation (e.g. `ls`, `cat`) counts as "wrote something." The agents may have legitimately done less work now that the retry pressure is gone, or may have written to incorrect paths.

This is a separate validation-leniency issue from the race:
- `src/sprint/sprint-runner.ts:115-117` — `WRITE_TOOLS = {file_write, file_edit, shell_exec}` counts any shell call.
- Tighter heuristic: require at least one `file_write`/`file_edit` for tasks whose description mentions a specific filename.

Not fixing in this patch — scope is validator race, not completeness checking. But the next priority to consider is: did sprint just get cheaper *because* it's doing less, or is the model legitimately more efficient without the retry-induced thrashing?

### (c) Per-node breakdown still unavailable

Same root as §2 of fix2-validation: source-tagging + redaction fix live on `origin/fix/debug-logger-signal-rerun`. One-line cherry-pick or a standalone debug-hygiene PR would unlock this for every future benchmark.

## Artifacts

- `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-pr78.jsonl`.
- `benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run5-pr78.jsonl`.
- Workdir: `~/personal/openpawl-test-projects/bench/cli-task-manager-sprint-pr78` — 3 source files, 147 source LOC, plus compiled dist/ output.
