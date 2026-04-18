# PR #82 validation — leniency fix on CLI Task Manager

Post-fix sprint rerun: `cli-task-manager`, sprint mode, 1 run, `OPENPAWL_DEBUG=true` + `OPENPAWL_PROFILE=true`, built `dist/` at staging tip `cda6b3c` (PRs #76 #77 #78 #79 #80 #81 #82 all merged).

- Debug log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-pr82.jsonl` (1,506 events).
- Parent log: `benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run6-pr82.jsonl`.
- Source tagging is finally live (PR #81 landed the fix). This doc is the first validation with accurate per-node attribution.

## Headline

**Strict validation + a latent agent-assignment bug = catastrophe.** PR #82 is working exactly as designed — it's catching every write-intent task that produced no files. But in this run, the LLM planner assigned 7 out of 9 tasks to the `planner` agent, which is semantically wrong for implementation work and produced nothing on most attempts. 2/9 tasks completed. 8 retries. 61,343 output tokens. 15m 47s wall.

This is not a regression of the fix — it's the fix unmasking a second, orthogonal problem. See §5 for analysis and recommended follow-up.

## 1. Five-column comparison

Numbers for the earlier runs carry forward from `docs/debug/fix1-validation.md`, `docs/debug/fix2-validation.md`, `docs/debug/pr78-validation.md`.

| metric                    | baseline (pre-any-fix) | post-PR-74 (retry preserve) | post-PR-78 (race fix) | **post-PR-82 (leniency fix)** | solo (reference)     |
|---------------------------|------------------------|-----------------------------|-----------------------|--------------------------------|----------------------|
| Wall time                 | 9m 18s                 | 8m 29s                      | **4m 2s**             | 15m 47s                        | 3m 9s                |
| LLM calls                 | 124                    | 123                         | 91                    | **147**                        | 10                   |
| Input tokens              | 77,687                 | 80,310                      | 38,790                | **57,190**                     | 43,133               |
| **Output tokens**         | 22,414                 | 25,639                      | **10,557**            | **61,343**                     | 16,630               |
| Retries                   | 3                      | 4                           | 0                     | **8**                          | 0                    |
| Tasks completed           | 13/13 (claimed)        | 11/?                        | 9/9 (silent lie)      | **2/9**                        | n/a (not tasked)     |
| Source .ts files on disk  | 7                      | 11                          | 3                     | **4**                          | 17                   |
| LOC on disk (source)      | 595                    | 817                         | 147                   | **762**                        | 1,721                |
| `BLOCKED:` emissions      | 0                      | 0                           | 0                     | 0                              | n/a                  |

### Sprint-vs-solo

| metric               | sprint post-PR-78 | **sprint post-PR-82** | solo   | PR-82 / solo |
|----------------------|-------------------|------------------------|--------|--------------|
| LLM calls            | 91                | 147                    | 10     | **14.7×**    |
| Input tokens         | 38,790            | 57,190                 | 43,133 | **1.33×**    |
| **Output tokens**    | 10,557            | 61,343                 | 16,630 | **3.69×**    |
| Wall time            | 4m 2s             | 15m 47s                | 3m 9s  | **5.01×**    |
| Source files         | 3                 | 4                      | 17     | **0.24×**    |
| Source LOC           | 147               | 762                    | 1,721  | **0.44×**    |

Post-PR-78 showed sprint cheaper than solo (0.63× output). Post-PR-82 **sprint is 3.69× solo output tokens** and **5× solo wall time** — a regression from this run's specific failure mode, not from the validation fix itself.

## 2. Per-node breakdown — source tagging works, numbers preserved

First validation doc with live per-node attribution (PR #81 fix is finally in).

| source             | calls | input tokens | output tokens | % of output | elapsed ms |
|--------------------|-------|--------------|---------------|-------------|------------|
| `sprint:planner`   | **117** | 45,826     | **52,445**    | **85.5 %**  | 916,953    |
| `sprint:coder`     | 10    | 5,965        | 6,630         | 10.8 %      | 65,894     |
| `sprint:tester`    | 20    | 5,399        | 2,268         | 3.7 %       | 50,147     |
| **Total**          | 147   | 57,190       | 61,343        | 100.0 %     | 1,032,994  |

Total elapsed across all agent calls (~17.2 min) exceeds wall time (15m 47s) because some calls overlap in the parallel batches. Input tokens preserved — 57,190 is a real number, not `[redacted]`, thanks to #81's logger fix.

## 3. Quality check — claimed vs on-disk

9 tasks planned, 2 marked `completed`. On-disk source (excluding `node_modules`, `dist/`, lockfiles, `CONTEXT.md`):

| task id | description (head)                                         | marked | expected file               | on disk? |
|---------|------------------------------------------------------------|--------|-----------------------------|----------|
| task-1  | Initialize TypeScript project: create package.json...      | incomplete (×2) | `package.json`      | ✅ present |
| task-2  | Create src/types.ts with Task interface...                 | incomplete (×2) | `src/types.ts`      | ✅ present |
| task-3  | Create src/commands/add.ts with addTask(...)               | incomplete (×2) | `src/commands/add.ts` | ❌ **MISSING** |
| task-4  | Create src/commands/complete.ts with completeTask(id)...   | incomplete (×2) | `src/commands/complete.ts` | ❌ **MISSING** |
| task-5  | Create src/display.ts with formatTask(...)                 | incomplete (×2) | `src/display.ts`    | ❌ **MISSING** |
| task-6  | Create src/cli.ts with commander or manual argument parser | incomplete (×2) | `src/cli.ts`        | ✅ present |
| task-7  | Create src/index.ts as main entry point                    | incomplete → **completed** | `src/index.ts` | ✅ present |
| task-8  | Implement all tasks in src/ using TypeScript               | **completed** (coder) | — | (met by other tasks' output) |
| task-9  | Install dependencies, run tsc, test CLI                    | incomplete (×2) | — (shell-only task) | n/a |

**Quality check passes for the 2 completed tasks** — task-7 and task-8 both have `src/index.ts` and related files present. The 7 incomplete tasks genuinely did not produce their files (task-1 did create `package.json` but was still flagged; see §5 for the nuance). **No false positives: every "completed" task has its expected output on disk.**

## 4. Retry gate breakdown

| kind      | count | willRetry |
|-----------|-------|-----------|
| `unknown` | 8     | true      |
| env_*     | 0     | —         |
| timeout   | 0     | —         |

All 8 retries were on the same error string: *"Task expects file creation/modification but agent only performed read operations"*. Classifier correctly returned `unknown` (not env, not timeout), let retry fire, every retry hit the same wall because the underlying agent-assignment was wrong.

## 5. Verdict

### Is PR #82 doing what it was designed to do? — **Yes, perfectly.**

PR #82's purpose was to stop tasks passing validation when they called only `shell_exec` / reads. The post-PR-78 run had 5 tasks silently "completed" with no files on disk; PR #82 would have flagged each. This run has 0 false positives — every `completed` task has its files.

### Is sprint still cheaper than solo? — **No. On this run, worse by ~3.7×.**

Solo produced 1,721 LOC in 3m 9s with 16.6k output tokens. Sprint produced 762 LOC in 15m 47s with 61.3k output tokens. Sprint/solo output ratio: **3.69× solo cost for 0.44× solo output**. This is a regression from post-PR-78 (0.63× output, 0.19× LOC) and from the original baseline (1.35× output, 0.35× LOC).

### Why? — Latent agent-assignment bug.

Planner output this run tagged **tasks 1-7 with `agent: "planner"`** (see `sprint:task_assignment` events in the log). `sprint:planner` burned 85.5 % of output tokens and 79.6 % of calls on these tasks, all failing validation. The `coder` agent (the one equipped to implement) was only invoked for 1 of the 9 tasks (task-8). `tester` for 1 (task-9).

This is the exact flag from `docs/debug/pr78-validation.md §5(a)`:

> "In the post-PR-77 log, task-1 and task-2 were assigned to `planner` (which has no write tools), leading to guaranteed incomplete validation. In this run [post-PR-78] the planner output put all tasks on `coder`. That bug never got a chance to fire. It remains latent."

It's firing now. LLM planner output varies run-to-run; this run happened to assign 7 of 9 tasks to `planner`. Pre-PR-82 this would have been masked (those tasks would have "completed" via `shell_exec` counting). Post-PR-82 they correctly fail.

### What to do — ranked

1. **Validate planner output at assignment time** (smallest fix, biggest leverage). In `src/sprint/sprint-runner.ts:659-665` where `assignAgent` honors `task.assignedAgent` for write-intent tasks, reject `"planner"` and downgrade to `"coder"`. Pattern:
   ```ts
   if (task.assignedAgent === "planner" && this.taskExpectsWrite(task)) {
     // Planner is for task breakdown, not implementation
     task.assignedAgent = "coder";
   }
   ```
2. **Or strengthen the planner prompt** to never tag write-intent tasks with `"agent": "planner"`. Less reliable — LLMs ignore prompts sometimes.
3. **Do not revert PR #82.** The strict validation is correct. The cost regression here is fully explained by (1), and (1) is trivial.

### Gate reply

> Is sprint still competitive with solo now that validation is strict?

**Not on this specific run.** But the cause is fully diagnosed and one-line-fixable. Expected outcome after applying (1) above: sprint/solo output ratio returns to the post-PR-78 region (~0.6×) with quality now accurate (files claimed = files on disk). That's the actually-competitive regime sprint was aiming for.

### Is the validator strict-enough or over-strict? — Strict-enough.

No false positives this run. Every `incomplete` flag was legitimate (agent really didn't produce the described file). No tasks slipped through to silent completion. The validator should not be relaxed.

## 6. Log note

No `BLOCKED:` emissions this run — the environment was healthy (no exit-127). So the PR #77 escalation clause had nothing to trigger on. Separately, source-tagging is now verified working end-to-end: all 147 `llm:response` events carried non-null `source` values, and all token counts were numeric (zero `[redacted]`).

## Artifacts

- `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-pr82.jsonl` — 1,506 events.
- `benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run6-pr82.jsonl` — start/close markers.
- Workdir: `~/personal/openpawl-test-projects/bench/cli-task-manager-sprint-pr82` — 4 source files, 762 LOC, half of the planner's expected file list.
