# Release v0.3.0 — session status

Closing snapshot for the two-day debug session (2026-04-17 → 2026-04-18).
v0.3.0 is cut on `staging`; `main` sync and tagging are deferred to a
future session.

## Current repository state

| ref                | sha       | head                                                              |
|--------------------|-----------|-------------------------------------------------------------------|
| `origin/staging`   | `bd57b94` | `chore: reconcile main into staging (accept dep bumps) (#86)`     |
| `origin/main`      | `3da27aa` | `chore(deps): Bump @fastify/static from 8.3.0 to 9.1.1 (#73)`     |
| local `staging`    | `bd57b94` | up to date with origin                                            |
| local `main`       | `3da27aa` | up to date with origin                                            |

No other local branches; all session feature branches (#83 `fix/planner-misassignment`, #82 `fix/task-validation-leniency`, #84 `feat/inter-task-context-sharing`, `chore/release-v0.3.0`, `chore/reconcile-main-into-staging`) have been deleted after verifying their content was squash-merged byte-identical into staging.

## Staging package state

- `package.json` version: **`0.3.0`**
- `@anthropic-ai/sdk`: **`^0.90.0`** (matched to main)
- `@fastify/static`: **`^9.1.1`** (matched to main)
- `bun.lock` regenerated and committed.

## Main still missing session work

`main` has **not** been caught up with `staging`. It remains at v0.1.0
shape (v0.2.0 never landed on main either). The 10 main-only commits
that `staging` now content-reconciles but does not topologically
contain (due to the squash-merge policy):

```
3da27aa chore(deps): Bump @fastify/static from 8.3.0 to 9.1.1 (#73)
ffe236f chore(deps): Bump @anthropic-ai/sdk from 0.79.0 to 0.90.0 (#74)
515cf72 fix(tui): reflow paragraph text and show tool activity in status bar (#60)
bef7085 Add files via upload (#61)
e4c718f docs: clean stale docs (#59)
63ec98b chore: merge staging into main (#69)
951a03f feat: add logo, screenshots, and fix security alerts (#58)
1f524ba release: v0.1.0 (#43)
b7b542e Merge pull request #2 from codepawl/dependabot/npm_and_yarn/npm_and_yarn-371a9f96ec
e824f76 chore(deps): Bump fastify in the npm_and_yarn group across 1 directory
```

## Deferred actions for next session

1. **`staging → main` merge.** Will re-surface conflicts on roughly the
   same 10-ish files (dep bumps, binaries, docs). Because `#86`
   **content-reconciled** main's unique work into staging, resolution is
   simpler than the first attempt — **keep staging's content on every
   conflict** (the dep bumps already match main, the binaries already
   match main, all src content is staging's).
2. **Manual TUI smoke test.** PR #60's paragraph-reflow behavior is
   presumed absorbed into staging's `src/tui/components/markdown.ts` and
   `messages.ts` rewrites, but this was NOT verified interactively
   (no TTY in the reconcile session). Before tagging, run
   `node dist/cli.js` for ~30 s and confirm text wrapping, status-bar
   tool activity, and markdown rendering look right.
3. **Tag `v0.3.0`** on main after the merge:
   `git tag -a v0.3.0 -m "Sprint retry, validation, and context-sharing release"`.
4. **GitHub release**: `gh release create v0.3.0 --generate-notes`.

## Known deferred issues (flagged, not blocking release)

- **`FILE_PATH_REGEX` false-positive on `"Node.js"`**
  (`planner-misassignment-diagnosis.md § Separate issue surfaced`).
  The `\w+\.js` alternative in `src/sprint/sprint-runner.ts`
  `FILE_PATH_REGEX` matches bare `Node.js` in task descriptions.
  Surfaced as one retry in the post-planner-fix rerun. Low-severity —
  the retry still produced the expected file. Follow-up: tighten the
  bare-filename branch to require a preceding `create`/`write` verb or
  a path separator.
- **PR #60 TUI reflow absorption presumption**. Tests pass, but
  interactive rendering was not exercised this session.

## Session outcome — benchmark impact

CLI Task Manager sprint benchmark, end-to-end:

| metric                      | session-start | post-v0.3.0 |
|-----------------------------|---------------|-------------|
| output tokens               | 22,414        | 10,976      |
| sprint/solo output ratio    | 2.08×         | **0.66×**   |
| `task-1` (scaffold) turns   | 20            | 10          |
| `src/types.ts` re-reads     | 18            | 4           |
| retry cascade false-positives | 5           | 0           |

Full investigation in `docs/debug/pr83-investigation.md`; reconciliation
plan in `docs/debug/reconcile-audit.md`; truncation classification for
the partial pre-fix log in `docs/debug/truncation-diagnosis.md`.

## Shipped in v0.3.0 (on staging only, not yet on main)

PRs #76, #77, #78, #81, #82, #83, #84, #85, #86.

Session can close.
