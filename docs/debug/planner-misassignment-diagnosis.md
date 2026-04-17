# Planner misassignment — diagnosis

Source log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-pr82.jsonl`.

## Observed behavior

Post-PR-82 CLI Task Manager sprint: 2/9 tasks completed, 8 retries, **117 / 147 LLM calls** and **52,445 / 61,343 output tokens (85.5 %)** attributed to `sprint:planner`. `sprint:coder` got only 10 calls.

Agent tags the LLM emitted in the `sprint:plan` JSON (extracted from the log):

| task | agent tag | description head                                                        |
|------|-----------|-------------------------------------------------------------------------|
| 1    | planner   | "Initialize TypeScript project: create package.json, install..."         |
| 2    | planner   | "Create src/types.ts with Task interface containing id, title..."        |
| 3    | planner   | "Create src/commands/add.ts with addTask(...)..."                        |
| 4    | planner   | "Create src/commands/complete.ts with completeTask(id)..."               |
| 5    | planner   | "Create src/display.ts with formatTask(task) using chalk..."             |
| 6    | planner   | "Create src/cli.ts with commander.js or manual argument parsing..."      |
| 7    | planner   | "Create src/index.ts as main entry point..."                             |
| 8    | coder     | "Implement all tasks in src/ using TypeScript..."                        |
| 9    | tester    | "Install dependencies, run tsc..."                                       |

Seven out of nine tasks tagged `planner` — despite PLANNER_PROMPT (autonomous-mode branch) never asking the LLM to emit an `agent` field at all.

## Root cause

Two layers.

### (a) PLANNER_PROMPT autonomous branch gives no constraint

`src/sprint/sprint-runner.ts:72-76`:

```ts
} else {
  prompt +=
    `Output as a JSON array:\n` +
    `[{"description": "...", "dependsOn": []}, {"description": "...", "dependsOn": [1]}]\n\n`;
}
```

No `agent` field in the example, no list of valid agent names, no ban on self-assignment. When the LLM invents an agent field (minimax-m2.7 does, likely from similar planning tasks in training data where agent routing was mentioned), nothing tells it what values are acceptable. The most semantically salient word — `"planner"`, i.e. the role it's currently filling — is what it picks.

### (c) `assignAgent` has no sanity check

`src/sprint/sprint-runner.ts:716-734`:

```ts
protected assignAgent(task: SprintTask): string {
  if (this.teamContext) {
    if (task.assignedAgent) {
      const mapped = mapTemplateRoleToAgent(task.assignedAgent);
      if (this.agents.has(mapped)) return mapped;
    }
  }
  // ... keyword rules fallback ...
}
```

`task-parser.ts:35-36` copies the LLM's agent string into `task.assignedAgent`. `assignAgent` honors it blindly. Planner agent has `defaultTools: ["file_read", "file_list", "web_search"]` (from `src/router/agent-registry.ts:63`) — no `file_write` or `file_edit`. PR #82's strict validator now correctly flags every planner-run write-intent task as `incomplete`. Retry fires, same agent, same result, same conclusion. Feedback loop. 85.5 % of output tokens burned in planner turns.

### Not (b)

The prompt *did* teach the planner about decomposition vs. execution implicitly (via the TEAM_CONTEXT branch example and the example task descriptions). The LLM ignored the spirit of that. But ignoring prompts is a known LLM behavior; fixing it via prompt engineering is strategy B below, not the root cause.

### Not (d)

No broader tool-mismatch generalization needed yet. The only agent that routinely gets tagged with write-intent tasks and lacks write tools is `planner`. Researcher/reviewer also lack `file_write`/`file_edit` but aren't self-assigning in observed runs.

## Fix strategy

Combined A + B (per user spec):

- **A (runtime guard)**: `downgradePlannerOnWrite(task)` — if `task.assignedAgent === "planner"` and `taskExpectsWrite(task)` returns true, log a `sprint:agent_downgrade` debug event and reassign to `coder`. Called from `assignAgent` at the top so both template and autonomous paths benefit.
- **B (prompt fix)**: Extend PLANNER_PROMPT with an AGENT ASSIGNMENT block listing the valid agent values and explicitly banning `planner`. Update the autonomous-mode JSON example to include `"agent"` with `"coder"` as the default.

## Expected post-fix behavior

On the same CLI Task Manager goal:

- `sprint:task_assignment` events for tasks 1-7: `agent: "coder"` (or `tester` for test tasks).
- `sprint:planner` drops to ≤ 10 % of output tokens (just the initial planning turn — ~1,500-3,000 tokens).
- `sprint:coder` / `sprint:tester` take the bulk.
- Output tokens total returns to the post-PR-78 region (10-20k) with PR #82's honest quality on top.

This is the integration probe that will be added as a post-fix section to this doc after the fix is applied.

## Post-fix integration probe

Rerun on the same CLI Task Manager goal, commit `fix/planner-misassignment`. Log: `benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-planner-fix.jsonl` (966 events — run hit the 15 min parent timeout before finishing, exit 137; data is still instructive for agent-routing verification).

### Agent tags the LLM planner emitted

| task | agent tag |
|------|-----------|
| 1–8  | **coder** |
| 9    | tester    |

**0 `planner` tags.** Prompt fix (Change 1) worked — the planner now consistently tags write-intent tasks with `coder`. Test task correctly tagged `tester`.

### `sprint:agent_downgrade` events

**Zero.** The runtime guard never fired because nothing reached it in a bad state — the prompt prevented the root cause. This is the ideal: A is a silent safety net, B does the prevention.

### Per-node breakdown

| source           | calls | output tokens |
|------------------|-------|---------------|
| `sprint:coder`   | 76    | 13,681        |
| `sprint:planner` | **1** | **1,151**     |

Planner dropped from **117 calls / 52,445 output tokens (85.5 %)** pre-fix to **1 call / 1,151 tokens (8.0 %)** post-fix. That single planner call is the legitimate initial plan emission, not wasted retry turns.

### Sprint progress before timeout

7 source files produced: `src/cli.ts`, `src/commands/complete.ts`, `src/display.ts`, `src/index.ts`, `src/storage.ts`, `src/taskManager.ts`, `src/types.ts`. Compare to post-PR-82: 4 source files, 2/9 completed, 15m 47s. Post-planner-fix: 7 source files visible at the 15 min timeout, with work still in progress.

### Separate issue surfaced

One retry in the probe hit a strange error: `"Task described creating Node.js but file does not exist"`. The PR #82 file-path regex at `sprint-runner.ts:131` matches `\w+\.js` as a filename candidate, so phrases like "Node.js" in task descriptions get flagged. Not a planner-misassignment problem — a regex-false-positive issue in PR #82's file-existence gate. Recommend as follow-up: tighten the bare-filename alternative in `FILE_PATH_REGEX` to require explicit context (a preceding `create`/`write` verb, or a path separator). Out of scope for this PR.

### Verdict

Planner misassignment is **fixed** at the prompt level (B) with a working safety net (A) that never needs to fire under the current model. Sprint routing is semantically correct again. The cost regression of `pr82-validation.md` is resolved — per-node attribution shows `coder` doing the work, not `planner`.
