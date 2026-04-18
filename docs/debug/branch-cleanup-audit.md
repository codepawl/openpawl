# Branch cleanup audit — 2026-04-17

## Before cleanup

Inventory captured after `git fetch --all --prune` (which auto-cleaned 19 stale remote-tracking refs — see `[deleted]` lines in the fetch output, all dependabot + merged topic branches that GitHub had already reaped on the remote).

### Local branches

| Branch | Last commit | Tracking | Action | Notes |
|---|---|---|---|---|
| `main` | `3da27aa chore(deps): Bump @fastify/static (#73)` | `origin/main` | **KEEP** | protected, production |
| `staging` | `1d4b6b6 chore: unify product tagline (#80)` | `origin/staging` | **KEEP** | protected, integration; now up-to-date |
| `chore/unify-tagline` | `d410538` | `origin/chore/unify-tagline: gone` | **DELETE_LOCAL** | PR #80 merged (squash). GitHub auto-deleted the remote. Local `git branch -d` will refuse because the squashed commit on `staging` has a different hash — user rule forbids `-D` force, so this is reported as an unresolvable case below if `-d` fails. |
| `fix/validation-parallel-race` | `8c7bc43` | `origin/fix/validation-parallel-race` | **DELETE_REMOTE then attempt DELETE_LOCAL** | PR #78 merged (squash). Remote branch lingered (GitHub did not auto-delete on this PR). Delete remote first, then local. |

### Remote branches (after prune)

| Branch | Last PR | PR state | Action | Notes |
|---|---|---|---|---|
| `origin/main` | — | — | **KEEP** | protected |
| `origin/staging` | — | — | **KEEP** | protected |
| `origin/feat/shell-exec-structured-result` | #76 | MERGED | **DELETE_REMOTE** | PR work landed on staging via squash; remote branch lingered. |
| `origin/fix/security-and-screenshots` | #58 | MERGED | **DELETE_REMOTE** | Landed via #58 (`2026-04-14T15:06:13Z`); 2 unique commits (`bcedaa6`, `cebf28c`) patch-id-verified present in main per earlier cleanup session. |
| `origin/fix/validation-parallel-race` | #78 | MERGED | **DELETE_REMOTE** | Landed via #78 (`2026-04-17T14:37:21Z`). |
| `origin/release/v0.1.0-final` | #43 | MERGED | **DELETE_REMOTE** | v0.1.0 release merge branch, landed via #43 (`2026-04-14T13:54:51Z`). |
| `origin/fix/debug-logger-signal-rerun` | — | NEVER OPENED | **INVESTIGATE** | 4 unique commits NOT on staging. See below. |

### Open PRs

None. `gh pr list --state open` returns `[]`.

### Recently merged PRs (for merge-state cross-reference)

All 2026-04-17 debug-session PRs merged: #80, #79, #78, #77, #76, #75. Earlier: #74, #73 (dependabot), #72 (sprint paths fix), #71 (benchmark tooling), #70 (screenshots), #69 (staging→main sync), #67, #66, #64.

### INVESTIGATE — `origin/fix/debug-logger-signal-rerun`

Unmerged commits (NOT on staging or main):

```
c364240 docs(debug): fix #1 validation — retry routing preserves original agent
1d7706b docs(debug): 2026-04-17 failure analysis, collab recon, sprint token breakdown, fix plan
de6b595 chore(debug): signal handler, redaction fix, source tagging, benchmark env/timeout/parent log
69dec03 fix(sprint): preserve original agent on retry instead of rerouting via keyword match
```

What it carries:
- `docs/debug/fix1-validation.md`, `docs/debug/sprint-token-breakdown.md` — baseline validation docs referenced by every subsequent fix-validation doc in this session (`fix2-validation.md` cites them as prior art).
- `de6b595` — structural commit: logger redaction regex fix (preserves numeric `inputTokens`/`outputTokens` that currently get redacted on staging), signal handler (graceful shutdown), source-tagging for LLM calls (`sprint:${agentName}`), benchmark env/timeout/parent log plumbing. Per `pr78-validation.md` §2, the absence of source-tagging on staging is what's blocking per-node token attribution in future benchmark reports.
- `69dec03` — the retry-routing fix ("preserve original agent on retry"). **This may have been superseded** by staging's current retry logic (PRs #77 #78) — worth a patch-id check before retention decisions, but the fact that its authoring flow is different from what landed suggests it remains semantically distinct.

**Recommendation: KEEP remote until user decides whether to merge `de6b595` (the logger/source-tagging fix) as a standalone PR.** The other three commits are docs/validation artifacts that can be extracted or dropped separately.

## Actions taken

Executed in Part 3 (see below). Only `git branch -d` (safe, refuses on unmerged work) and `git push origin --delete` (for explicitly-verified merged branches) used. No `-D` force flag. `main` and `staging` untouched.

## After cleanup

### Deletions executed

**Remote — 4 branches removed via `git push origin --delete`:**
- `origin/feat/shell-exec-structured-result` (PR #76 merged)
- `origin/fix/security-and-screenshots` (PR #58 merged)
- `origin/fix/validation-parallel-race` (PR #78 merged)
- `origin/release/v0.1.0-final` (PR #43 merged)

**Remote-tracking prune:** `git remote prune origin` — no-op after the deletes (already cleaned in the initial `fetch --prune`).

**Local — 2 deletions attempted, BOTH REFUSED by `git branch -d`:**

```
error: the branch 'chore/unify-tagline' is not fully merged.
error: the branch 'fix/validation-parallel-race' is not fully merged.
```

Per user rule: **reporting, not force-deleting**. Both branches carry work that was squash-merged to staging (verified by the `(#78)` and `(#80)` marker commits visible in `git log --oneline staging | head -3`):

- `chore/unify-tagline` (d410538) ↔ staging commit `1d4b6b6 chore: unify product tagline (#80)`
- `fix/validation-parallel-race` (8c7bc43) ↔ staging commit `620a9c2 fix(sprint): attribute tool calls by explicit taskIndex (#78)`

The squash-merge changes the commit SHA, so `-d` cannot see the local tip as reachable. Options:

1. **User runs `git branch -D <name>`** for each after confirming the squash-merge counterpart on staging is satisfactory. Equivalent patch, different SHA — no work lost.
2. **Leave the branches as archival pointers** until they become stale (no-op; harmless).

### Final state

**Local branches:**

| Branch | Last commit | Justification |
|---|---|---|
| `main` | `3da27aa chore(deps): Bump @fastify/static (#73)` | KEEP — protected, production |
| `staging` | `1d4b6b6 chore: unify product tagline (#80)` | KEEP — protected, integration, up-to-date |
| `chore/unify-tagline` | `d410538` | retained (squash-merge; `-d` refused; user decision needed for `-D`) |
| `fix/validation-parallel-race` | `8c7bc43` | retained (squash-merge; `-d` refused; user decision needed for `-D`) |

**Remote branches:**

| Branch | Justification |
|---|---|
| `origin/main` | KEEP — protected |
| `origin/staging` | KEEP — protected |
| `origin/fix/debug-logger-signal-rerun` | INVESTIGATE — 4 unmerged commits, see pre-cleanup section. Carries `de6b595` (logger redaction fix + source-tagging, currently blocking per-node benchmark breakdowns) + `fix1-validation.md` + `sprint-token-breakdown.md` baseline docs. Pending user decision on whether to extract `de6b595` into a standalone PR. |

### Verification

- `main` commit: `3da27aa` — unchanged from pre-cleanup.
- `staging` commit: `1d4b6b6` — unchanged from pre-cleanup (only the pull from origin advanced it from `6e6b59a` to the current `1d4b6b6` during the #80 catchup, which was a fast-forward pull, not a branch rewrite).
- Zero force pushes. Zero `-D` force deletes. Zero branches with un-PR'd work discarded.
- All deleted remote branches' work is confirmed present on `origin/staging` (for #78, #76) or `origin/main` (for #58, #43).

