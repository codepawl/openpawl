# /auto-debug

Run the auto debug loop on a specific OpenPawl issue.

Usage: /auto-debug <description>

Example: /auto-debug "Sprint fails with JSON parse error on task 3"
Example: /auto-debug "Status bar stays idle during tool execution"
Example: /auto-debug "Collab mode falls back to solo unexpectedly"

## Arguments

$ARGUMENTS

## Steps

1. Parse the issue description
2. Determine which mode/scenario to test
3. Run the DETECT -> DIAGNOSE -> FIX -> VERIFY loop (see openpawl-auto-debug skill)
4. Report results
5. Ask user: "Commit this fix? [Y/n]"
