# /ux-audit

Run a user experience audit on OpenPawl.

Usage: /ux-audit [journey]

Journeys: first-time, daily, sprint, config, error, power-user, all

Example: /ux-audit first-time
Example: /ux-audit error
Example: /ux-audit all

## Arguments

$ARGUMENTS

## Steps

1. Parse the journey argument (default: all)
2. Walk through specified user journey (see openpawl-ux skill)
3. Note friction points with severity
4. Categorize and prioritize by frequency x severity
5. Ask user which improvements to apply
6. Apply one at a time with verify after each
