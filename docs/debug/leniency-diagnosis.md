# Validation leniency diagnosis

Source log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-pr78.jsonl`.
Workdir: `~/personal/openpawl-test-projects/bench/cli-task-manager-sprint-pr78/`.

## Per-task findings (tasks 5–9)

For each task in the PR-#78 rerun, planner's expected file output vs what actually hit disk:

| task   | description (head)                                             | agent  | tools observed (first attempt) | expected file          | on disk after run?     | final status |
|--------|----------------------------------------------------------------|--------|---------------------------------|-----------------------|------------------------|--------------|
| task-5 | "Create src/display.ts using chalk for colored output…"        | coder  | only `file_read`/`file_list`/`shell_exec` — **0 file_write** | `src/display.ts`       | **MISSING**            | completed    |
| task-6 | "Create src/cli.ts with command parser…"                       | coder  | only `file_read`/`file_list`/`shell_exec` — **0 file_write** | `src/cli.ts`           | **MISSING**            | completed    |
| task-7 | "Create src/index.ts as CLI entry point…"                      | coder  | 1× `file_read`, 6× `shell_exec`, `file_list` — **0 file_write** | `src/index.ts`         | **MISSING**            | completed    |
| task-8 | "Add package.json script 'start': … Update README.md…"         | coder  | 2× `file_read`, 2× `file_list`, 7× `shell_exec` — **0 file_write** | updated `package.json`, `README.md` | no README.md (and no `"start"` script added) | completed    |
| task-9 | "Write tests in src/__tests__/tasks.test.ts…"                  | tester | interleaved with task-5/task-6 parallel batch; **0 file_write** in its share | `src/__tests__/tasks.test.ts` | **MISSING**            | completed    |

Workdir contents (source files only, excluding `node_modules/` and `dist/`): `src/storage.ts`, `src/tasks.ts`, `src/types.ts`, `test-chalk.ts`, `package.json`, `tsconfig.json`. Tasks 1–4's outputs are present (types, storage, tasks, package.json). Tasks 5–9's outputs are all **missing** despite 5/5 "completed" status in the event stream.

## Why validation passed

The task validator at `src/sprint/sprint-runner.ts:498-510` routes through `taskDidWrite` (`:585-587`):

```ts
private taskDidWrite(task: SprintTask): boolean {
  return (task.toolsCalled ?? []).some((t) => WRITE_TOOLS.has(t));
}
```

with the set at `:117`:

```ts
const WRITE_TOOLS = new Set(["file_write", "file_edit", "shell_exec"]);
```

`shell_exec` is in `WRITE_TOOLS`. Every task 5–9 called `shell_exec` at least once (running `ls`, `cat`, `which`, etc. — command types shown in the task's own tool stream). So `taskDidWrite` returned true, validator took the `else` branch (`task.status = "completed"`), sprint reported 9/9 success, and missing files were silently accepted.

Before PR #78, the parallel-attribution race masked this bug: tasks 5–9 were getting their `shell_exec` records *attributed to other parallel tasks*, so their own `toolsCalled` lists were often empty, which produced `taskDidWrite: false` and flagged them incomplete. With the race fixed, attribution is correct — and now every `shell_exec` a task actually made counts as "I wrote something." The leniency bug was always there; it was just hidden.

## Hypothesis check (user's queue)

- **(a) `WRITE_TOOLS` is too lenient (`shell_exec` counted as write)** — **TRUE**. The direct cause of tasks 5–9 getting `completed`. A task that runs `shell_exec("ls")` and nothing else passes `taskDidWrite`.
- **(b) `WRITE_INTENT_KEYWORDS` is too aggressive** — partially true. `"install"` and `"configure"` can legitimately involve no file creation (e.g. `npm install`), so their presence as write-intent triggers is marginal. Lower priority than (a); fix for hygiene.
- **(c) Expected files aren't verified against disk** — **TRUE** and is the belt-and-suspenders fix. Even if `taskDidWrite` returns true for the right reason, the agent may write a different file than the one the description named. A lightweight `access(path)` check against paths mentioned in the description would catch this.

## Proposed fix

**Priority 1 (resolves §tasks-5–9)** — `WRITE_TOOLS` shrinks to `["file_write", "file_edit"]`. Remove `shell_exec`. Rationale: `shell_exec` has too many non-write uses (`ls`, `cat`, `which`, test runners). Tasks that legitimately only need shell (e.g. "run tests") should have `taskExpectsWrite` return `false`, not sneak through on `taskDidWrite`.

**Priority 2** — Trim `WRITE_INTENT_KEYWORDS` to `["create", "build", "implement", "write", "add", "generate"]`. Drop ambiguous: `"install"`, `"setup"`, `"set up"`, `"configure"`. Tasks containing only these ambiguous words will now get `taskExpectsWrite: false` and be considered complete by default. This favours false negatives (letting a no-op task slide) over false positives (retrying or flagging a task that actually didn't need to write).

**Priority 3** — File-existence gate. After `taskDidWrite` returns true, extract file paths from the task description (regex for strings like `src/foo.ts`, `package.json`, `.gitignore`, `README.md`) and verify each mentioned path exists on disk. If any are missing, mark `incomplete` with `"Task described creating <path> but file does not exist"`. Catches cases where the agent writes to the wrong path (e.g. `test-chalk.ts` at repo root instead of `src/display.ts`).

## Scope (what's NOT fixed here)

- Not touching retry logic (PR #77's `isRetriable`).
- Not touching the classifier (PR #77's `error-classify.ts`).
- Not adding `blocked` status.
- Not changing agent prompts.

## Artifact references

- `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-pr78.jsonl` — 1,082 events.
- `~/personal/openpawl-test-projects/bench/cli-task-manager-sprint-pr78/` — final workdir, 3 source .ts files out of the 9 tasks' expected output.
- `docs/debug/pr78-validation.md §5(b)` — where this flag was first raised.
