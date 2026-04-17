# Fix #2 validation — error classifier + retry gating + agent escalation

Post-fix sprint rerun: `cli-task-manager`, sprint mode, 1 run, `OPENPAWL_DEBUG=true` + `OPENPAWL_PROFILE=true`, built `dist/` at commit `feat/error-classifier-and-retry-gating` tip (contains PRs #76 + #77).

- Debug log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-fix2.jsonl` (1,606 events).
- Parent log: `benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run4-postfix2.jsonl`.
- Branch: `feat/error-classifier-and-retry-gating` (PR #77 not yet merged to staging at time of run; PR #76 merged via #76).

## Headline

**The env-retry cascade never fired on this benchmark** because CLI Task Manager produces zero `exit 127` / "command not found" shells. The `minimax-m2.7` model called `npm install chalk` and friends successfully. So the classifier had nothing to block and the escalation prompt had nothing to trigger. The fix is correct; this task does not exercise it.

**Output tokens rose +35 %** (25,639 → 34,630) vs post-fix1. Driver: **5 retries this run vs 4 last run** on the same validation-heuristic false positive path (`"Task expects file creation/modification but agent only performed read operations"`), not an env error. All 5 retries were classified `unknown` by the new classifier — correctly — and therefore proceeded, consuming turns.

The user-specified gate ("If output token reduction is less than 25 % from post-fix1: flag in verdict") is **tripped**. See §6.

## 1. Comparison table (4-column, totals)

| metric              | baseline (pre-any-fix) | post-PR #74 (fix1)    | post-PR #76 (exitCode surfacing) | post-PR #77 (classifier + escalation) |
|---------------------|------------------------|-----------------------|-----------------------------------|----------------------------------------|
| Wall time           | 9m 18s                 | 8m 29s                | (not measured — data-plumbing only) | 9m 14s                                 |
| LLM calls           | 124                    | 123                   | "                                 | **121**                                |
| Input tokens        | 77,687                 | 80,310                | "                                 | **86,815** (+8 %)                      |
| **Output tokens**   | 22,414                 | 25,639                | "                                 | **34,630** (+35 % vs #74)              |
| Files produced      | 7                      | 11                    | "                                 | **14**                                 |
| LOC produced        | 595                    | 817                   | "                                 | **1,086**                              |
| Retries             | 3                      | 4                     | "                                 | **5**                                  |
| `BLOCKED:` emits    | n/a                    | n/a                   | "                                 | **0**                                  |
| Exit-127 shells     | n/a                    | n/a                   | "                                 | **0**                                  |

Notes:
- PR #76 (exitCode surfacing) was not independently measured because it is purely data-plumbing — no behavioral change until a consumer reads the new fields. PR #77 is the first PR to close the loop.
- Input tokens rose because more retried tasks append "[RETRY — previous attempt failed…]" hints to task descriptions, and later-task "Prior work" blocks grow correspondingly.
- Files and LOC rose because more retries produced more file_writes. More output is not quality — see §5.

## 2. Per-node breakdown — NOT available

The source-tagging commit (`de6b595` on `origin/fix/debug-logger-signal-rerun`) that adds `source: "sprint:${agentName}"` to `callLLMMultiTurn` options, plus the redaction-regex fix that preserves `inputTokens`/`outputTokens` in debug events (otherwise they get stringified to `[redacted]` because the key `tokens` matches the `/key|token|.../i` pattern), is **not on this branch**. Without it, per-node token attribution from the JSONL is impossible — every `llm:response` event records `source: null`, `inputTokens: "[redacted]"`, `outputTokens: "[redacted]"`.

Two options to recover this section in a follow-up rerun:
1. Cherry-pick `de6b595`'s logger/llm.ts changes onto this branch, rebuild `dist/`, rerun. Cost: ~10 min + API budget. Produces per-node breakdown for post-PR-77.
2. Merge PR #75 (docs-only) + `de6b595` into a unified validation branch for future benchmark runs.

**Action deferred to user decision** — §6 verdict does not depend on per-node breakdown to make the central call.

Aggregate call counts are available from the log:

| source                                   | calls (inferred)  |
|------------------------------------------|-------------------|
| `llm:request` / `llm:response` (total)   | 121               |
| Tool-only turns (response length 0)      | ~95 (78 %, consistent with baseline 87.9 %) |
| Text-emitting turns                      | ~26               |

Tool-call names across all turns:

| tool          | count |
|---------------|-------|
| shell_exec    | 64    |
| file_read     | 56    |
| file_write    | 28    |
| file_list     | 19    |
| file_edit     | 2     |
| git_ops       | 1     |
| cli-task-manager (MCP?) | 2 |

## 3. Retry gate events

5 `sprint:retry_gate` events emitted — all on the "incomplete" validation-heuristic path, not env errors:

| # | taskId | kind      | signal | willRetry | errorHead |
|---|--------|-----------|--------|-----------|-----------|
| 1 | task-1 | `unknown` | —      | true      | "Task expects file creation/modification but agent only performed read operations" |
| 2 | task-2 | `unknown` | —      | true      | "Task expects file creation/modification but agent only performed read operations" |
| 3 | task-3 | `unknown` | —      | true      | "Task expects file creation/modification but agent only performed read operations" |
| 4 | task-6 | `unknown` | —      | true      | "Task expects file creation/modification but agent only performed read operations" |
| 5 | task-7 | `unknown` | —      | true      | "Task expects file creation/modification but agent only performed read operations" |

**Zero retries where kind is `env_*` or `timeout`.** All retries fell through to the "agent didn't write a file" path, which the classifier (correctly) does not classify as terminal. The classifier is doing its job: it only short-circuits retries that it recognizes as unwinnable in the same env. This error is "agent produced read-only output despite write-intent description" — that *might* be winnable on retry (agent may change behavior), and was indeed retried.

## 4. `BLOCKED:` occurrences

**Count: 0** across all `llm:response` events.

| agent   | count | what was reported blocked |
|---------|-------|---------------------------|
| coder   | 0     | —                         |
| tester  | 0     | —                         |
| debugger| 0     | —                         |
| assistant | 0   | —                         |

Reason: the escalation clause only triggers on `exit 127` or "command not found" stderr. The run produced 64 `shell_exec` calls with exit codes:

| exit | count |
|------|-------|
| 0    | 55    |
| 1    | 7     |
| 2    | 1     |
| 127  | **0** |

`minimax-m2.7` ran `npm init -y`, `npm install chalk`, `npm install --save-dev typescript vitest`, `npx tsc --init`, etc., all successfully. The env had `npm`, `npx`, and `tsc` available. No missing-dependency condition arose, so the escalation clause stayed silent. This is the expected behavior — escalation should not fire when the environment is healthy. It is not evidence the clause doesn't work; it is evidence the clause had nothing to work on.

## 5. Sprint / solo ratio comparison

Solo baseline from `docs/debug/sprint-token-breakdown.md` (same model, same goal, same debug flags, reported at 3m 9s / 43.1k in / 16.6k out / 17 files / 1,721 LOC).

| metric          | solo (baseline) | sprint post-PR-77 | ratio (sprint / solo) | ratio post-PR-74 (for reference) |
|-----------------|-----------------|-------------------|-----------------------|----------------------------------|
| LLM calls       | 10              | 121               | **12.1×**             | 12.4×                            |
| Input tokens    | 43,133          | 86,815            | **2.01×**             | 1.80×                            |
| **Output tokens** | 16,630        | 34,630            | **2.08×**             | 1.35×                            |
| Wall time       | 3m 9s           | 9m 14s            | **2.93×**             | 2.95×                            |
| Files produced  | 17              | 14                | **0.82×**             | 0.41×                            |
| LOC produced    | 1,721           | 1,086             | **0.63×**             | 0.35×                            |

**Sprint/solo output ratio went up, not down** (1.35× → 2.08×). Every hypothesis direction was wrong on this benchmark:

- Hypothesized: output tokens drop 40–60 % (25.6k → 10–15k). **Actual: +35 % (25.6k → 34.6k).**
- Hypothesized: wall time drops 30–40 %. **Actual: +9 % (8m 29s → 9m 14s).**
- Hypothesized: zero sprint retries where kind is env_*. **Actual: zero env retries — but only because there were no env errors to begin with, not because the classifier blocked any.**
- Hypothesized: sprint/solo output ratio drops from 1.35× to below 1.0×. **Actual: rose to 2.08×.**

Files/LOC ratio *did* improve vs post-PR-74 (0.41× → 0.82× files; 0.35× → 0.63× LOC), because more retries produced more writes. This is not a quality improvement — no rubric scoring was run, and several of the produced files are duplicates at both `src/` and repo root (`cli.ts`, `tasks.ts`, `storage.ts`, `display.ts`, `types.ts` all appear twice — indicating a structural confusion the agents didn't resolve).

## 6. Verdict

### Did the env-retry cascade get eliminated? — **Yes, vacuously.**

Evidence:
- 0 `exit 127` shell calls in the run.
- 0 `BLOCKED:` emissions.
- 0 `sprint:retry_gate` events with `kind == env_*` or `timeout`.

The classifier and escalation clause are wired correctly — they produced the null result they should have on a task where `npm install` works. There is no data from this benchmark that contradicts the hypothesis that the fixes would eliminate an env cascade when one actually happens. But there is no data confirming it either.

**To get positive evidence the fix works in the target scenario**, a benchmark with a deliberately missing dependency is required. Suggested follow-up: run the same sprint in a workdir without `npm` in `PATH`, or with a goal that requires a CLI tool known not to be installed (e.g., `"build a Rust extension using cargo-wasm-pack"`). Expected behavior: first `shell_exec` returns exit 127, `classifyTask` returns `env_command_not_found`, `isRetriable` returns false, the task does not retry, **and** the agent emits `BLOCKED: cargo-wasm-pack`.

### Is sprint/solo now favorable or neutral for this task? — **No.** It got worse.

Evidence: sprint/solo output token ratio went from 1.35× to 2.08×; wall time held at ~2.9×; LOC produced remained ~0.63× of solo. Sprint is now producing 63 % of solo's code for 2.08× the output cost — a sharp regression from the already-unfavorable baseline.

### Why output rose despite the fix being correct

The actual retry driver on this benchmark is **not** the env-retry cascade. It is the validation heuristic at `src/sprint/sprint-runner.ts:498-510`:

```ts
if (this.taskExpectsWrite(task) && !this.taskDidWrite(task)) {
  task.status = "incomplete";
  task.error = "Task expects file creation/modification but agent only performed read operations";
  ...
}
```

All 5 retries hit this branch. `taskExpectsWrite` is a keyword check against `WRITE_INTENT_KEYWORDS` (`"create", "build", "implement", "write", "add", "generate", "set up", "setup", "configure", "install"`). `taskDidWrite` checks whether any of `file_write`, `file_edit`, or `shell_exec` were in `task.toolsCalled`. The tasks being flagged presumably ran `file_read` and produced text output but didn't touch a write tool. Each retry spends another ~10 turns (sprint `maxTurns: 10`) and adds to output.

The fix ranking in the original analysis was based on a hypothesized env-error cascade. The *actual* dominant retry cause on this benchmark is a heuristic false positive that neither PR #76 nor PR #77 addresses. Candidate Priority 2b that would move this metric:

- **Relax `taskExpectsWrite` keywords** — drop `"install"`, `"setup"`, `"configure"` (these often mean a config edit, a shell command, or no-op validation), keeping `"create"`, `"implement"`, `"write"`, `"add"`, `"generate"`. OR make the write check look at file-level evidence in the workdir (did any new file appear?) rather than tool-call names.
- **Or**: make "incomplete" terminal after one attempt — if the agent says "I reviewed the codebase" in response to a "create X" task, retrying with the same agent hasn't historically fixed it.

### User gate

> "If output token reduction is less than 25 % from post-fix1: flag in verdict section with possible causes. Do NOT auto-proceed to further fixes without user review."

**Flagged.** Output rose +35 %, not dropped. Possible causes ranked:

1. **Wrong target**. PR #77 targets env-retry (exit 127). This benchmark has 0 exit 127s. Fix was never going to move this needle.
2. **Validation heuristic false positives are the real retry driver** on this task. 5 / 5 retries hit the "expects write, didn't write" branch. See proposal above.
3. **LLM variability**. Same model, same goal, two different runs — nominal variance in a single-run benchmark can reach ±15 %. A +35 % swing is outside variance, but a portion of it may be run-to-run noise rather than structural.
4. **More retries → more work**, not less. Each extra retry adds ~10 turns. 5 retries × ~10 turns × ~160 tokens/turn ≈ 8k output tokens difference — roughly matches the 34.6k − 25.6k = 9k delta. So the "extra cost" is fully accounted for by the extra retry, which is downstream of (2).

No further implementation fixes should proceed until the user decides whether to:
- (a) Accept PRs #76 and #77 as correct-but-unexercised on this benchmark, and focus next work on the validation heuristic;
- (b) Re-rerun with per-node tagging (via cherry-pick of `de6b595`) to see if output breakdown points somewhere else;
- (c) Run a second benchmark with a deliberately missing CLI dep to generate positive evidence PR #77 eliminates an actual env cascade.

## Artifacts

- `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-fix2.jsonl` — 1,606 events.
- `benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run4-postfix2.jsonl` — start and close markers.
- Workdir: `~/personal/openpawl-test-projects/bench/cli-task-manager-sprint-postfix2` — 14 produced source files, 1,086 LOC.
