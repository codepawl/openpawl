# OpenPawl Git Flow Skill

## When to use
After completing work on one or more topic branches and need to
merge everything into staging cleanly.

## Prerequisites
- gh CLI authenticated: `gh auth status`
- On a topic branch or staging
- All checks pass: `bun run typecheck && bun run lint && bun run test`

## The Flow

```
CHECK → COMMIT → PUSH → MERGE → CLEAN → VERIFY
```

## Phase 1: CHECK

```bash
# Verify gh CLI is authenticated
gh auth status

# Check current branch
git branch --show-current

# Check for uncommitted changes
git status --short

# Check all local branches
git branch --list | grep -v "main\|staging"

# Check remote sync
git fetch origin
git log --oneline origin/staging..staging 2>/dev/null
```

Report:
```
Current branch: feat/debug-logging
Uncommitted changes: 3 files modified
Local topic branches:
  feat/debug-logging (ahead 2)
  fix/workdir-nesting (ahead 1)
  feat/benchmark (ahead 3)
Staging: up to date with origin
```

## Phase 2: COMMIT

For each branch with uncommitted changes:

```bash
# Stage all changes
git add -A

# Review what's staged
git diff --cached --stat

# Check for accidents
git diff --cached --stat | awk '{print $1}' | while read f; do
  size=$(wc -c < "$f" 2>/dev/null || echo 0)
  if [ "$size" -gt 512000 ]; then
    echo "WARNING: $f is $(($size/1024))KB"
  fi
done

# Commit with conventional message
git commit -m "type(scope): description"
```

Commit message rules:
- feat: new feature
- fix: bug fix
- refactor: code change (no new feature, no fix)
- chore: maintenance (deps, config, cleanup)
- docs: documentation
- test: adding/fixing tests

ASK USER for commit message if not obvious.

## Phase 3: PUSH

```bash
# Push current branch
git push origin $(git branch --show-current)

# If rejected (behind remote), rebase first
git pull --rebase origin $(git branch --show-current)
git push origin $(git branch --show-current)
```

## Phase 4: MERGE to staging

For each topic branch, in dependency order:

```bash
# Switch to staging
git checkout staging
git pull origin staging

# Merge topic branch (no-ff for clean history)
git merge --no-ff <branch> -m "merge: <branch> into staging"

# Run checks after merge
bun run typecheck && bun run lint && bun run test

# If checks fail: abort and report
# git reset --hard HEAD~1
# echo "MERGE FAILED: <branch> breaks checks"

# If checks pass: push staging
git push origin staging
```

Order matters: merge branches that others depend on first.
If unsure about order, merge by commit date (oldest first).

Alternative: if branch has a PR, use gh CLI:
```bash
# Create PR if not exists
gh pr create --base staging --head <branch> \
  --title "merge: <branch>" --body "Auto-merge via git-flow skill"

# Merge PR (squash for clean history)
gh pr merge <branch> --squash --delete-branch
```

## Phase 5: CLEAN

```bash
# Delete merged local branches
git branch --merged staging | grep -v "main\|staging\|\*" | xargs -r git branch -d

# Delete merged remote branches
git branch -r --merged staging | grep -v "main\|staging\|HEAD" | \
  sed 's/origin\///' | xargs -r -I{} git push origin --delete {}

# Prune stale remote refs
git remote prune origin

# If branch delete fails (packed refs):
# git update-ref -d refs/heads/<branch>
```

## Phase 6: VERIFY

```bash
# Confirm staging is clean
git checkout staging
git status

# Confirm no stale branches
git branch --list | grep -v "main\|staging"
# Should be empty

# Confirm remote branches cleaned
git branch -r | grep -v "main\|staging\|HEAD"
# Should be empty (or only PR branches)

# Confirm checks still pass
bun run typecheck && bun run lint && bun run test

# Show merge log
git log --oneline -10 staging
```

Report:
```
Merged to staging:
  ✓ feat/debug-logging (3 commits)
  ✓ fix/workdir-nesting (1 commit)
  ✓ feat/benchmark (2 commits)

Cleaned:
  ✓ 3 local branches deleted
  ✓ 3 remote branches deleted

Staging: 6 commits ahead of main
Tests: 475 pass, 0 fail
```

## Safety Rules

1. NEVER merge directly to main (PRs only)
2. NEVER force push staging or main
3. ALWAYS run checks after each merge
4. ALWAYS ask user before deleting branches with unmerged commits
5. If merge conflict: STOP and ask user
6. If checks fail after merge: revert and report
7. Max 10 branches per batch (ask if more)
8. Skip branches with open PRs (they have their own flow)

## Conflict Resolution

If merge conflict:
```bash
# Show conflicts
git diff --name-only --diff-filter=U

# Report to user
echo "Conflict in: <files>"
echo "Options:"
echo "  1. Resolve manually and continue"
echo "  2. Abort this merge, continue with other branches"
echo "  3. Stop entirely"
```

NEVER auto-resolve conflicts. Always ask user.

## Bulk Operations

If merging > 5 branches:
```
WARNING: About to merge 8 branches into staging.
Branches (oldest first):
  1. fix/json-parsing (2 days ago, 1 commit)
  2. feat/collab-force (1 day ago, 2 commits)
  3. fix/workdir (1 day ago, 1 commit)
  ...
Proceed? [Y/n/list]
```
