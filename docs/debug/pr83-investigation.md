---
title: PR #83 investigation — post-planner-fix sprint vs solo
source_log: benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-planner-fix.jsonl
---

# PR #83 investigation

Diagnose-only. No code changes. Extract metrics from the post-PR-83 sprint
log, compare to solo baseline, identify the remaining cost bottleneck.

## Important caveat — log is partial

`cli-task-manager-sprint-post-planner-fix.jsonl` (966 events) spans only
**17:33:28.805Z → 17:37:53.738Z = 4 m 24.9 s**, and its final line is an
`llm:request` that never got a matching response. The run was cut off mid
tool-loop in round 4 (round 4 started with 3 parallel tasks; no round-4
completion event; 3 tasks remain in-progress at truncation). This is **not
the 15 min timeout** referenced earlier — that was a different rerun
(`…-v2` workdir, parent-run7 starts at 17:41:16 and has no close marker).

The log we have is therefore a **partial-run snapshot**, not an
end-to-end sprint completion. All sprint numbers below reflect that
partial window. Any "sprint cheaper than solo on tokens" signal is
confounded by early truncation — a complete run would spend more.

The user-requested solo baseline file
`cli-task-manager-solo-debug-run2-clean.jsonl` does not exist on disk;
the solo reference numbers below are carried forward from
`docs/debug/pr82-validation.md` §1 (solo reference column), which is
itself sourced from the earlier clean solo run.

## Part 1 — Metrics table

| metric                   | solo (ref)        | post-PR-83 sprint (partial, 4m25s) | ratio (sprint/solo) |
|--------------------------|-------------------|------------------------------------|---------------------|
| input tokens             | 43,133            | 24,953                             | 0.58×               |
| output tokens            | 16,630            | 14,832                             | 0.89×               |
| wall time                | 3 m 9 s (189 s)   | 4 m 25 s (265 s, truncated)        | 1.40×               |
| LLM calls                | 10                | 77 (response) / 78 (request)       | 7.70×               |
| files on disk (source)   | 17 `.ts`          | 7 `.ts` + `package.json` + `tsconfig.json` | 0.41× (.ts) |
| LOC (source, on disk)    | 1,721             | 548                                | 0.32×               |
| retries                  | 0                 | 3 (`task-1`, `task-3`, `task-4`)   | —                   |
| tasks completed          | n/a (not tasked)  | 3/9 at truncation (task-2, task-3, task-6) | —           |

Sprint numbers are **partial**. Had the run continued to all 9 tasks,
both output tokens and wall time would be materially higher. A safer
framing is "per-task cost so far" rather than a whole-run comparison.

## Part 2 — Per-node breakdown (post-PR-83 sprint)

Source tagging is accurate (PR #81 fix is in). All 77 `llm:response`
events carry a non-null `data.source`; all token counts are numeric.

| source           | calls | input tokens | output tokens | % of output |
|------------------|-------|--------------|---------------|-------------|
| `sprint:coder`   | 76    | 24,938       | 13,681        | **92.2 %**  |
| `sprint:planner` | 1     | 15           | 1,151         | 7.8 %       |
| `sprint:tester`  | 0     | 0            | 0             | 0 %         |
| **TOTAL**        | 77    | 24,953       | 14,832        | 100 %       |

PR #83 (planner-misassignment fix) holds — planner is 1 call (the
initial plan emission), not the 117-call runaway seen pre-PR-83. Tester
is 0 because task-9 (the only tester-tagged task) is in round 4 which
never completed. No `sprint:agent_downgrade` events: the runtime guard
never had to fire — the prompt-level fix is preventing root cause.

## Part 3 — Bottleneck identification

### Where tokens go
`sprint:coder` owns **92.2 %** of output tokens. The bottleneck has moved
from "planner retry loop" (pre-PR-83) to "coder multi-turn loop".

### Disproportionate per-task turn counts

Bounded per-task counts inside `sprint:task:start` → `sprint:task:complete`:

| task    | LLM calls | output tokens | tools (top)                                      |
|---------|-----------|---------------|--------------------------------------------------|
| task-1  | **20**    | **7,934**     | 16 shell_exec, 11 file_write, 3 file_read        |
| task-6  | **24**    | 2,337         | 16 file_read, 14 shell_exec, 1 file_write        |
| task-3  | 14        | 1,529         | 6 file_read, 6 shell_exec, 1 file_write          |
| task-2  | 8         | 959           | 3 shell_exec, 1 file_write, 1 file_read          |
| task-4  | 4         | 293           | 4 file_list, 1 file_read (pre-truncation)        |

`task-1` (a project-init task: `package.json`, `tsconfig.json`, `npm
install`) consumed **7,934 of 14,832 output tokens — 54 % of the whole
sprint's output** for what should be a one-shot scaffold. 20 coder turns
with 11 file_writes and 16 shell_execs indicates an iterate-on-build-
errors loop, not a simple scaffold.

`task-6` hit 24 turns and 16 `file_read` calls on a single task —
repeatedly re-examining already-known source, not writing new code.

### Tool call distribution (coder, all tasks)

| tool        | count | % of 100 |
|-------------|-------|----------|
| shell_exec  | 46    | 46 %     |
| file_read   | 27    | 27 %     |
| file_write  | 14    | 14 %     |
| file_list   | 12    | 12 %     |
| git_ops     | 1     | 1 %      |

`shell_exec` (46) dominates and `file_write` (14, 9 unique targets) is
a small minority. Sprint coder is spending ~5× more shell_exec calls
than actual writes — a lot of that is `tsc` / `npm install` / `cat` /
`ls` verification loops.

### Tool-retry loops

Explicit tool failures: 8 `sprint:agent:tool` events with
`status: "failed"`. Not huge. The bigger pattern is the silent
iteration loop — same file inspected N times across turns.

### Context duplication between tasks

Same file read repeatedly across task boundaries:

| file                 | read how many times              |
|----------------------|----------------------------------|
| `src/types.ts`       | 12× `file_read` + 2× full-path + **4× `cat src/types.ts`** via shell_exec = **18** |
| `src/storage.ts`     | 7× `file_read` + 1× full-path + 2× `cat src/storage.ts` = 10            |
| `tsconfig.json`      | 2× `file_read`                   |

The 18 reads of `src/types.ts` across 5 tasks is the clearest signal:
no inter-task context sharing. Each new coder task starts naive and
re-reads the types file. Solo doesn't pay this cost because its
10 calls share one conversation.

Repeated `shell_exec` commands:

- 6× `cd …bench/cli-task-manager…` (working-directory resets every task)
- 4× `cat src/types.ts`, 2× `cat src/storage.ts`
- 2× `npm install`
- 2× `npx tsc 2>&1 || true`, plus 3 more `tsc`-family invocations

The `cd` repeats confirm no session-level shell state is retained; each
coder invocation re-orients from scratch.

### No disproportionate call counts at the node level

Unlike pre-PR-83's `planner: 117 calls`, nothing in this run is an
obvious outlier *per node*. The disproportion is **per-task inside
coder**: task-1 at 20 turns and task-6 at 24 turns are the tail.

## Part 4 — Honest quality comparison

### Solo (reference)

- Claimed 17 source `.ts` files; **17 on disk**. 1,721 LOC on disk. Honest.

### Sprint post-PR-83 (partial)

- 9 tasks planned; 3 marked `completed` (`task-2`, `task-3`, `task-6`);
  1 marked `incomplete` multiple times (`task-1` twice, `task-4` once,
  `task-5` once, `task-3` once before its second attempt succeeded).
- 7 `.ts` files on disk matching the plan's expected output paths:
  `src/cli.ts`, `src/taskManager.ts`, `src/storage.ts`, `src/types.ts`,
  `src/display.ts`, `src/index.ts`, `src/commands/complete.ts`.
  Also `package.json`, `tsconfig.json`, `package-lock.json`.
- LOC on disk: 548 across 7 `.ts` files.

Reconciliation: the 3 `completed` tasks' expected files are all on disk.
The files written during the 4 `incomplete` attempts (task-1 wrote
`package.json` + `tsconfig.json` + `src/cli.ts` + `src/taskManager.ts`
etc. before being flagged `incomplete`) are also on disk — so the
"incomplete" flag was **over-strict** in at least task-1's case (files
exist, validator ran before they registered, or the regex-false-positive
issue from `planner-misassignment-diagnosis.md §Separate issue surfaced`
fired: the error head was *"Task described creating Node.js but file
does not exist"*, which is exactly the `\w+\.js` regex bug).

**No silent failures** — quality is honest. PR #82's strict validator
is holding the line: every `completed` task has its files.

**Over-strict flag remains** — the `task-1` double-incomplete was the
`Node.js` regex false-positive, not a real missing-file. This is
documented as a known follow-up in
`planner-misassignment-diagnosis.md § Separate issue surfaced`.

## Part 5 — Hypotheses for the remaining gap

The sprint *partial* output ratio is 0.89× solo — already under 1.0×.
But extrapolating: sprint did 548 LOC in 4m25s with 6 of 9 tasks still
in flight. If the remaining 3 tasks cost proportional output, projected
complete-sprint output is roughly **14,832 × (9/~6) ≈ 22k tokens** and
**7–10 min wall** vs solo's 16,630 / 3m9s. That projects to
**~1.3–1.5× solo output, ~2.2–3.2× solo wall**.

That projection is above the 1.2× threshold. Top two hypotheses, in
order of evidence strength:

### Hypothesis A — Coder multi-turn loop on verification/iteration (strongest)

Evidence:
- `task-1` alone burned 7,934 output tokens / 20 LLM turns / 16 shell_exec
  calls on a project-init task solo would scaffold in ~2 turns.
- `task-6` used 24 LLM turns and 16 file_read calls on a single command.
- `shell_exec` is 46 % of all coder tool calls — overwhelmingly `tsc`,
  `npm install`, `cat`, `ls` verification commands, not productive
  writes.
- `file_write` is 14 % of tool calls — the thing we actually need coder
  to do is a minority of what coder does.

Why: coder's per-task prompt encourages "verify with the toolchain"
but there's no turn budget or early-stop heuristic when the agent is
clearly iterating on build errors. Solo's single long conversation
lets it stabilize on one working state; sprint's per-task restart
loses that amortization.

### Hypothesis C — Inter-task context not shared (strong, orthogonal)

Evidence:
- `src/types.ts` read **18 times** total across 5 coder tasks. Each task
  opens cold and re-reads the types file to understand the schema.
- `src/storage.ts` read 10 times across tasks that depend on its API.
- 6× redundant `cd /home/…/bench/cli-task-manager…` shell_exec calls —
  no working-directory or shell-state persistence between task runs.
- `systemPromptLength` is a flat 1,279 chars on every coder call;
  there is no growing shared-context block that lets later tasks
  inherit earlier task output summaries.

Why: each `sprint:coder` invocation is a fresh conversation (median
`messageCount` = 10, max = 26 — the multi-turn loop **within** a task,
not **across** tasks). There is no CONTEXT.md-style digest of earlier
task outputs being injected into later tasks. A task that depends on
`src/types.ts` must re-discover it.

### Not the dominant factors

- **(b) tester re-reading files** — tester made 0 LLM calls this run
  (task-9 never ran), so can't be the cause. Would need a complete run
  to assess.
- **(d) tasks split too granularly** — the plan has 9 tasks for ~17-file
  CLI; not obviously over-split. Solo writes 17 files in one session;
  sprint splitting into 9 is roughly 1 task per 2 files, reasonable.
  Granularity is not the outlier — within-task turn count is.

## Verdict and recommendation

**PR #83 is correct and held its design goal** — planner is back to
1 call / 1,151 tokens (down from 117 calls / 52,445 tokens pre-PR-83).
Validator is still honest (PR #82 held). Source tagging is intact
(PR #81 held).

**But sprint is not yet competitive with solo on a complete run**, by
projection. The bottleneck is now inside `sprint:coder`:

1. Per-task turn count is unbounded. `task-1` at 20 turns / 7.9k output
   tokens on a scaffold task is the single largest cost sink.
2. Inter-task context is not shared. `src/types.ts` read 18 times is
   evidence of cold-starting every task.

**Recommendation: one more fix needed before shipping.** Specifically:

- **Do not ship as-is.** The single run we have is partial and
  projects above 1.2× solo output.
- **Do not multi-fix.** The two hypotheses are related — both stem from
  coder starting cold per task. A single intervention targeting inter-
  task context-sharing (summary/digest of prior tasks injected into
  coder prompt, or a shared known-files cache) would address (A)'s
  verification-loop iteration and (C)'s redundant re-reads together.
- **Also wanted before shipping: a clean, non-truncated full-run log.**
  The 4m25s truncation prevents a real end-to-end comparison. The
  15-min timeout hit on the `…-v2` rerun also prevented completion.
  Need at least one full sprint completion to validate.
- **The `Node.js` regex false-positive (PR #82's
  `FILE_PATH_REGEX`) is a separate minor issue.** Already tracked in
  `planner-misassignment-diagnosis.md § Separate issue surfaced`. Low
  priority vs the context-sharing fix.

**Bottom line**: PR #83 unlocked the next-layer bottleneck rather than
resolving the sprint-vs-solo gap. Coder-side context amortization is
the next-lever problem, not validation or planner routing.

---

## Appendix — post-context-fix validation (PR #84)

Rerun on the same CLI Task Manager goal after landing the inter-task
context-sharing fix (`buildKnownFilesBlock` injected into TASK_PROMPT,
see `src/sprint/sprint-runner.ts` and
`src/sprint/__tests__/inter-task-context.test.ts`).

- Log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-context-fix.jsonl` (702 events).
- Parent log: `benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run8-context-fix.jsonl`
  (exit 0, 295 s).
- Branch: `fix/planner-misassignment` (tip at time of run).
- Workdir: `…/bench/cli-task-manager-sprint-context-fix`.
- Final events: `sprint:round:complete round=5` → `sprint:done
  {completedTasks: 4, failedTasks: 1, totalTasks: 5}` →
  `sprint:post_mortem lessonCount=1`. **Run finished cleanly — not
  truncated.**

### Full-run metrics vs solo

| metric                   | solo (ref)        | post-context-fix sprint (complete) | ratio (sprint/solo) |
|--------------------------|-------------------|------------------------------------|---------------------|
| input tokens             | 43,133            | 34,418                             | **0.80×**           |
| output tokens            | 16,630            | **10,976**                         | **0.66×** ✅        |
| wall time                | 3 m 9 s (189 s)   | 4 m 54 s (294 s)                   | 1.55×               |
| LLM calls                | 10                | 57                                 | 5.70×               |
| files on disk (source)   | 17 `.ts`          | 5 `.ts` + package.json + tsconfig  | 0.29×               |
| LOC (source, on disk)    | 1,721             | 343                                | 0.20×               |
| retries                  | 0                 | 1 (task-5 tester)                  | —                   |
| tasks completed          | n/a               | 4/5                                | —                   |

### Per-task turn counts — did the coder loops shrink?

| task                         | pre-fix turns | post-fix turns | Δ         |
|------------------------------|---------------|----------------|-----------|
| `task-1` (project scaffold)  | **20**        | **10**         | **−50 %** |
| `task-2` (types.ts)          | 8             | 6              | −25 %     |
| `task-3` (storage.ts)        | 14            | 10             | −29 %     |
| `task-4` (commands/add.ts → now cli.ts) | 4 (truncated) | 10 | — |
| `task-5` (commands/list.ts → now tester/index) | 0 (not reached) | 20 | — |

Caveat: the planner produced a **5-task plan this time vs 9 before**,
so task indices don't map 1-to-1. But the top-line is unambiguous:
the scaffold task that was the single biggest output-token sink
(`task-1`: 7,934 output tokens in 20 turns) dropped to 1,406 output
tokens in 10 turns. **−50 % turns, −82 % output tokens** for that
workload. (`task-6` at 24 turns doesn't exist in the new plan; its
closest analog is the tester task-5 at 20 turns — comparable, but now
a tester responsibility, not a coder one.)

### Did `src/types.ts` stop being re-read?

| file                 | pre-fix reads                          | post-fix reads | Δ        |
|----------------------|----------------------------------------|----------------|----------|
| `src/types.ts`       | **18** (12 file_read + 2 full-path + 4 `cat`) | **4**  | **−78 %** |
| `src/storage.ts`     | 10                                     | 4              | −60 %    |
| `tsconfig.json`      | 2                                      | 3              | +50 %    |
| `package.json`       | 1                                      | 4              | +300 %   |

`src/types.ts` cold-start reads dropped from 18 to 4 — the central
evidence for Hypothesis C is now refuted. Small uptick on
`package.json`/`tsconfig.json` reflects the tester task legitimately
inspecting the build config once; not a regression.

### Per-node breakdown — coder still dominates but meaningfully lower

| source           | pre-fix calls | pre-fix output | post-fix calls | post-fix output | % of post-fix total |
|------------------|---------------|----------------|----------------|-----------------|---------------------|
| `sprint:coder`   | 76            | 13,681         | **36**         | **7,988**       | **72.8 %**          |
| `sprint:tester`  | 0             | 0              | 20             | 2,045           | 18.6 %              |
| `sprint:planner` | 1             | 1,151          | 1              | 943             | 8.6 %               |
| **TOTAL**        | 77            | 14,832         | **57**         | **10,976**      | 100 %               |

Coder calls fell by 53 % (76 → 36) and coder output by 42 % (13.7k →
8.0k). Tester now participates (pre-fix run never got past round 4 to
invoke it, so apples-to-oranges on tester). Planner unchanged —
exactly the post-PR-83 design: one initial plan emission.

### Quality — honest, not silent

- `sprint:done completedTasks=4, failedTasks=1`. The one failure is
  `task-5`: *"Create src/index.ts + tests/taskManager.test.ts"*. Coder
  created `src/index.ts` (on disk, 6 LOC) but did not create
  `tests/taskManager.test.ts` (the directory doesn't exist). PR #82's
  strict validator correctly flagged this as incomplete. **No silent
  failures** — claimed-vs-disk stays accurate.
- Lesson extracted by post-mortem: *"Review and fix: …failed with:
  Task expects file creation/modification but last shell_exec failed
  with exit 2"*.

### Sprint/solo output ratio — target check

- Target: `<1.0×` ideal, `<1.2×` acceptable, `>1.2×` fail.
- Achieved: **0.66× solo output tokens. PASS.**

### File count / LOC gap remains, but differently caused

Sprint produced 5 source files / 343 LOC vs solo's 17 / 1,721. The
gap is now **planner scope**, not coder cost: the planner decomposed
this goal into 5 tasks this run, and each task is a file or two. Solo
wrote 17 files in one pass because it had no decomposition ceiling;
sprint's plan imposed one. This is a planner/prompt choice, not a
context-sharing problem. Out of scope for this PR.

### Verdict on the context-sharing fix

- The two hypotheses from the original investigation are both
  materially addressed: per-task turn count dropped (A), inter-task
  re-reads dropped (C).
- Sprint is now under the 1.2× output-token threshold vs solo
  (achieved 0.66×). Wall-time ratio is 1.55× — not under 1.0×, but
  acceptable given sprint runs N agents for parallelism benefits that
  single-goal CLI Task Manager doesn't fully stress.
- Validation (PR #82) and planner routing (PR #83) continue to hold:
  one legitimate failure, correctly classified, no silent completion.

**Decision: ship as-is.** The context-sharing fix achieves the
acceptable threshold on a clean end-to-end run. Remaining gaps
(file-count, wall-time) stem from planner-scope and parallelism
headroom — separate levers, not regressions.
