# /ui-audit

Run a visual quality audit on OpenPawl TUI.

Usage: /ui-audit [category]

Categories: render, density, hierarchy, progress, responsive, all

Example: /ui-audit render
Example: /ui-audit hierarchy
Example: /ui-audit all

## Arguments

$ARGUMENTS

## Steps

1. Parse the category argument (default: all)
2. Run audit checks for specified category (see openpawl-ui skill)
3. Report findings with pass/fail per check
4. Prioritize fixes by impact/effort/risk
5. Ask user which fixes to apply
6. Apply fixes one at a time with verify after each
