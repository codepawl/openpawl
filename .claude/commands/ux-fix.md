# /ux-fix

Fix a specific UX friction point.

Usage: /ux-fix <description>

Example: /ux-fix "first-time user sees blank screen"
Example: /ux-fix "Esc doesn't work in /team view"
Example: /ux-fix "error message not helpful when API fails"
Example: /ux-fix "too many keystrokes to switch model"

## Arguments

$ARGUMENTS

## Steps

1. Identify journey affected (first-time/daily/sprint/config/error/power-user)
2. Walk through the friction point (see openpawl-ux skill)
3. Categorize (dead end/feedback/cognitive load/inconsistency/discoverability/error/speed)
4. Propose improvement with diff preview
5. Ask user: "Apply this improvement? [Y/n]"
6. Apply change, run typecheck + test + build
7. Re-walk the affected journey to verify
8. Ask user: "Commit this fix? [Y/n]"
