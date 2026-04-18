# Reconcile main → staging — audit & resolution plan

**Goal**: eliminate drift between `main` and `staging` by merging `main`
into `staging`. After this merge, `staging` contains everything `main`
has plus the session work (PRs #71–#84 + v0.3.0 bump). A subsequent
session will handle `staging → main` for release.

**Do not execute the merge until the resolution plan below is reviewed.**

## Part 1 — Main-only commits (10)

| sha       | date       | title                                                        | reality check |
|-----------|------------|--------------------------------------------------------------|---------------|
| 3da27aa   | 2026-04-17 | chore(deps): Bump @fastify/static 8.3.0 → 9.1.1 (#73)        | **real value** — newer version not in staging |
| ffe236f   | 2026-04-17 | chore(deps): Bump @anthropic-ai/sdk 0.79.0 → 0.90.0 (#74)    | **real value** — newer version not in staging |
| 515cf72   | 2026-04-15 | fix(tui): reflow paragraph text & status bar tool activity (#60) | likely already superseded by staging rewrites (staging's `src/tui/components/markdown.ts` + `messages.ts` were reworked post-#60) |
| bef7085   | 2026-04-15 | Add files via upload (#61)                                   | replaces `assets/logo.png` with 4,953-byte version; staging still has older 22,205-byte logo |
| e4c718f   | 2026-04-15 | docs: clean stale docs (#59)                                 | deletes `docs/ARCHITECTURE.md`, `docs/CUSTOM_AGENTS.md`, etc. — already absent from staging |
| 63ec98b   | 2026-04-15 | chore: merge staging into main (#69)                         | historical merge commit; structural ancestor |
| 951a03f   | 2026-04-14 | feat: add logo, screenshots, and fix security alerts (#58)   | older; superseded by #61 and by staging's screenshot tree |
| 1f524ba   | 2026-04-14 | release: v0.1.0 (#43)                                        | ancient v0.1.0 release commit; staging's history already reflects |
| b7b542e   | 2026-03-31 | Merge pull request #2 (dependabot fastify npm_and_yarn)      | ancient; from pre-bun era (pnpm-lock); staging has dropped pnpm |
| e824f76   | 2026-03-25 | chore(deps): Bump fastify in npm_and_yarn group               | ancient; same pre-bun era |

### Files touched by main-only commits (surface area)

| commit  | scope                                                       |
|---------|-------------------------------------------------------------|
| 3da27aa | `package.json` only                                         |
| ffe236f | `package.json` only                                         |
| 515cf72 | `src/app/*`, `src/tui/components/markdown.ts`, `messages.ts` (6 files) |
| bef7085 | `assets/logo.png`, `assets/logo.svg`                        |
| e4c718f | doc deletions + README small edit                           |
| 63ec98b | `.github/workflows/codeql.yml` deletion, `README.md`, `src/commands/settings.ts`, `src/tools/built-in/git-ops.ts`, `src/web/static/terminal.html` addition |
| 951a03f | `assets/*`, `docs/screenshots/*`, `README.md`               |
| 1f524ba | release housekeeping (`.env.example`, `.github/*`, `package.json` v0.1.0) |
| b7b542e + e824f76 | `package.json`, `pnpm-lock.yaml` (obsolete — project uses bun now) |

### Flagged commits (touch `package.json` or source)

- **3da27aa, ffe236f** — real dep bumps; must preserve main's versions.
- **515cf72** — TUI reflow; check whether staging's current files functionally contain this.
- **63ec98b, 951a03f, 1f524ba, b7b542e, e824f76** — ancient / historical; staging's history already descends from their effects.

## Part 2 — Dry-run merge results

`git merge main --no-commit --no-ff` produced **59 conflict files** (add/add or content conflicts), distributed:

| top-dir        | files |
|----------------|-------|
| `src/tui/`     | 14    |
| `src/app/`     | 11    |
| `src/router/`  | 6     |
| `src/sprint/`  | 4     |
| `docs/screenshots/` | 3 |
| `src/utils/`   | 2     |
| `src/tools/`   | 2     |
| `tests/sprint/`| 1     |
| `src/onboard/`, `src/memory/`, `src/handoff/`, `src/engine/`, `src/drift/`, `src/core/`, `src/context/`, `src/commands/`, `src/cli/` | 1 each |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `.gitignore`, `package.json` | 1 each |
| `assets/logo.{png,svg}` | 2 |

Merge aborted cleanly; working tree restored to clean `staging`.

## Part 3 — Per-file resolution plan

### DEP — `package.json`

**Resolution: manual 3-way merge.** Keep staging's **metadata** (`version: "0.3.0"`, `description: "Terminal AI coding with a team of agents, not just one."`, `scripts.benchmark`) and take main's **dep versions** (`@anthropic-ai/sdk: "^0.90.0"`, `@fastify/static: "^9.1.1"`).

**Action**: after `git merge` halts, edit `package.json` manually, then `bun install` to regenerate the lock file. Stage both.

### CODE — 54 files under `src/`, `tests/`

**Resolution: keep staging (`--ours`).** Rationale:

- Staging contains PRs #71–#84 which rewrote most of the TUI, router, sprint, and utils layers.
- The only main-only src change (#60, `src/tui/components/markdown.ts` + `messages.ts`) predates those rewrites; staging's current code is the successor.
- PR #60's *intent* (paragraph reflow + tool activity in status bar) is present in staging's markdown/status-bar rewrites; we'll verify by running the full test suite post-merge.

**Action**: for each of the 59 conflicts under `src/` and `tests/`, `git checkout --ours <file>` then `git add <file>`.

**Files**:
```
src/app/commands/sprint.ts
src/app/headless.ts
src/app/init-session-router.ts
src/app/input-handler.ts
src/app/interactive/settings-view.ts
src/app/keybindings-setup.ts
src/app/router-wiring.ts
src/app/shell.ts
src/app/tool-permission.ts
src/app/tui-callbacks.ts
src/app/welcome.ts
src/cli/command-registry.ts
src/commands/logs.ts
src/context/compaction.ts
src/core/sandbox.ts
src/drift/detector.ts
src/engine/llm.ts
src/handoff/resume-generator.ts
src/memory/hybrid-retriever.ts
src/onboard/setup-flow.ts
src/router/agent-registry.ts
src/router/collab-dispatch.ts
src/router/dispatch-strategy.ts
src/router/llm-agent-runner.ts
src/router/prompt-router.ts
src/router/router-types.ts
src/sprint/create-sprint-runner.ts
src/sprint/post-mortem.ts
src/sprint/sprint-runner.ts
src/sprint/types.ts
src/tools/built-in/shell-exec.ts
src/tools/executor.ts
src/tui/components/editor.ts
src/tui/components/markdown.ts
src/tui/components/messages.ts
src/tui/components/status-bar.ts
src/tui/components/status-indicator.ts
src/tui/components/tool-call-view.ts
src/tui/constants/icons.ts
src/tui/core/tui.ts
src/tui/keybindings/keybinding-help.ts
src/tui/keyboard/actions.ts
src/tui/keyboard/keymap-presets.ts
src/tui/layout/responsive.ts
src/tui/themes/built-in/theme-builder.ts
src/tui/themes/default.ts
src/utils/formatters.ts
src/utils/safe-json-parse.ts
tests/sprint/sprint-runner.test.ts
```

### DOC — `CHANGELOG.md`, `README.md`, `CLAUDE.md`

- **CHANGELOG.md**: keep staging (`--ours`). Staging has `[0.3.0]`, `[0.2.0]`, `[0.1.0]` entries. Main's is stale.
- **CLAUDE.md**: keep staging (`--ours`). Staging's is 306 lines of changes newer, reflecting the current codebase; main's is pre-v0.1.0.
- **README.md**: keep staging (`--ours`). 82-line delta; staging's was rewritten per `docs: clean stale docs (#59)` direction plus later edits.

### CONFIG — `.gitignore`

**Resolution: keep staging (`--ours`).** Staging's is a strict superset — it adds `.openpawl/` and `benchmarks/debug-reruns/` / `benchmarks/benchmark-parent.jsonl` ignores that main lacks. No semantic information would be lost.

### BINARY — `assets/logo.png`, `assets/logo.svg`, `docs/screenshots/*.png`

- **`assets/logo.png`**: take main (`--theirs`). Main's 4,953-byte version (from #61) replaced staging's 22,205-byte version; main is newer.
- **`assets/logo.svg`**: take main (`--theirs`). Same #61 commit updated both.
- **`docs/screenshots/collab.png`, `sprint.png`, `welcome.png`**: take main (`--theirs`). From #58 + later updates; the corresponding staging versions are older or absent.

## Summary of resolution actions

| category | files | strategy |
|---|---|---|
| `package.json` | 1 | **manual merge**: staging metadata + main deps + `bun install` |
| src/ and tests/ | 49 | `--ours` (staging) |
| docs (CHANGELOG, README, CLAUDE.md) | 3 | `--ours` (staging) |
| `.gitignore` | 1 | `--ours` (staging) |
| binaries (`assets/*`, `docs/screenshots/*`) | 5 | `--theirs` (main) |

## Post-merge verification gate

After applying the resolutions and before committing the merge:

1. `bun install` — regenerate `bun.lockb` with the upgraded deps
2. `bun run typecheck` — must pass
3. `bun run lint` — must pass
4. `bun run test` — must pass (expected 524 pass / 19 skip / 0 fail)

**If any check fails: `git merge --abort` and report which files caused it.** Do not commit a broken merge.

## Risk notes

- The only substantive loss candidate is **PR #60's** TUI reflow. Staging's `src/tui/components/markdown.ts` and `messages.ts` were substantially rewritten after #60 landed on main and appear to incorporate the same behavior; the post-merge test suite is the verification gate. If tests detect a regression, we escalate to a targeted cherry-pick of #60's intent onto staging.
- **`bun install`** will rewrite `bun.lockb`. That's expected under a dep bump — it's the point of accepting main's newer versions. The lockfile change must be committed as part of the merge.
- No destructive operations proposed. No force-push, no tag, no release.

## Awaiting approval

Plan written. **Do not execute** the merge without explicit user confirmation of the resolutions above.
