# /git-flow

Merge all topic branches into staging and clean up.

Usage: /git-flow [options]

Options:
  --dry-run    Show what would happen without doing it
  --branch X   Merge only specific branch
  --skip-clean Don't delete merged branches
  --pr         Use gh PR merge instead of local merge

Steps:
1. Check: uncommitted changes, local branches, remote sync
2. Commit: stage and commit pending changes (ask for message)
3. Push: push all topic branches to origin
4. Merge: merge each into staging with checks after each
5. Clean: delete merged local + remote branches
6. Verify: confirm staging is clean, tests pass

Example:
  /git-flow                    # merge all, clean all
  /git-flow --dry-run          # show plan without executing
  /git-flow --branch feat/x    # merge only feat/x
  /git-flow --pr               # use GitHub PRs
