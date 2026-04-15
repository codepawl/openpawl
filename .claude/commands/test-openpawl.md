# /test-openpawl

Run an OpenPawl test scenario and analyze the results.

Usage: /test-openpawl <scenario> [goal]

Scenarios: solo, collab, sprint, template, stress

## Arguments

$ARGUMENTS

## Steps

1. Parse scenario from arguments (solo, collab, sprint, template, stress)
2. Clean previous test output for this scenario:
   ```bash
   rm -rf ~/personal/openpawl-test-projects/test-<scenario>
   ```
3. Build OpenPawl first:
   ```bash
   cd ~/personal/openpawl && bun run build
   ```
4. Run the scenario with debug logging enabled:
   ```bash
   OPENPAWL_DEBUG=true openpawl run --headless \
     --mode <mode> \
     --goal "<goal>" \
     --workdir ~/personal/openpawl-test-projects/test-<scenario>
   ```
   Mode mapping: solo->solo, collab->collab, sprint->sprint, template->sprint (with --template indie-hacker), stress->sprint (with --runs 2)
5. Check exit code
6. Read debug logs:
   ```bash
   openpawl logs debug --session latest
   openpawl logs debug --session latest --level error
   ```
7. Check output files:
   ```bash
   ls -la ~/personal/openpawl-test-projects/test-<scenario>/
   cat ~/personal/openpawl-test-projects/test-<scenario>/CONTEXT.md 2>/dev/null
   ```
8. Report: pass/fail with evidence from debug logs
9. If fail: analyze logs, identify root cause, propose fix (ASK USER before applying)
