# /ui-fix

Fix a specific UI issue using the audit skill.

Usage: /ui-fix <description>

Example: /ui-fix "tool calls don't show spinner"
Example: /ui-fix "flicker when scrolling chat"
Example: /ui-fix "colors wrong in 16-color terminal"
Example: /ui-fix "status bar shows idle during tool execution"

## Arguments

$ARGUMENTS

## Steps

1. Identify category (render/density/hierarchy/progress/responsive)
2. Run targeted audit for that category (see openpawl-ui skill)
3. Diagnose the specific issue in source code
4. Propose fix with diff preview
5. Ask user: "Apply this fix? [Y/n]"
6. Apply fix, run typecheck + test + build
7. Manual verify in terminal
8. Ask user: "Commit this fix? [Y/n]"
