# OpenPawl Auto Debug Skill

## When to use
When OpenPawl has a bug or feature that needs investigation,
fix, and verification. This skill implements an autonomous
debug loop with safety gates.

## The Loop

```
DETECT -> DIAGNOSE -> FIX -> VERIFY -> (repeat or done)
```

Max iterations: 5
Max same-error retries: 2
Always ask user before applying fix.

## Phase 1: DETECT

Run the failing scenario with full debug logging:
```bash
OPENPAWL_DEBUG=true OPENPAWL_PROFILE=true openpawl run --headless \
  --mode <mode> --goal "<goal>" \
  --workdir ~/personal/openpawl-test-projects/auto-debug-$(date +%s)
```

Capture:
- Exit code
- Debug log (JSONL)
- Profile report
- stdout/stderr
- Generated files

If exit code = 0 and output looks correct -> DONE (no bug)

## Phase 2: DIAGNOSE

Read debug logs systematically:
```bash
# 1. Errors first
openpawl logs debug --session latest --level error

# 2. Timeline around the error
openpawl logs debug --session latest --timeline

# 3. Specific source
openpawl logs debug --session latest --source <source of error>

# 4. LLM prompts/responses if output quality issue
openpawl logs debug --session latest --source llm
```

Produce a diagnosis:
```
ROOT CAUSE: [one sentence]
EVIDENCE: [log entries that prove it]
SOURCE FILE: [exact file and function]
FIX CATEGORY: [prompt|logic|wiring|parsing|rendering]
CONFIDENCE: [high|medium|low]
```

If confidence = low -> ASK USER for more context before proceeding.

## Phase 3: FIX

Based on diagnosis category:

### prompt fix
- Read the agent's system prompt from source
- Identify what's missing or misleading
- Propose specific prompt changes
- ASK USER: "Modify prompt in <file>:<line>? [Y/n]"

### logic fix
- Read the source function
- Identify the bug (off-by-one, wrong condition, missing case)
- Propose minimal code change
- ASK USER: "Apply this fix to <file>? [Y/n]"

### wiring fix
- Trace event flow from emitter to listener
- Identify where the chain breaks
- Propose wiring change
- ASK USER: "Wire <event> in <file>? [Y/n]"

### parsing fix
- Check safeJsonParse layers
- Check what the LLM actually returned (from debug log)
- Propose parsing improvement
- ASK USER: "Add parsing fallback in <file>? [Y/n]"

### rendering fix
- Check component that renders the output
- Identify where data is lost or malformed
- Propose display fix
- ASK USER: "Fix rendering in <file>? [Y/n]"

RULES:
- Fix must be < 50 lines changed
- If fix is > 50 lines -> decompose into smaller atomic fixes
- Each atomic fix gets its own verify cycle
- Never change test assertions to hide bugs
- Never delete features to avoid bugs

## Phase 4: VERIFY

After fix is applied:
```bash
# 1. Type check
bun run typecheck

# 2. Tests
bun run test

# 3. Re-run the EXACT same scenario
OPENPAWL_DEBUG=true openpawl run --headless \
  --mode <same mode> --goal "<same goal>" \
  --workdir ~/personal/openpawl-test-projects/auto-debug-verify-$(date +%s)

# 4. Compare logs
openpawl logs debug --session latest --level error
# Should be: no errors (or different errors)
```

If same error -> increment retry counter
If retry counter >= 2 for same error -> STOP, report to user:
"Tried 2 times, same error persists. Root cause may be deeper."

If different error -> new DETECT cycle (max 5 total iterations)
If no errors + output correct -> DONE

## Phase 5: REPORT

After loop completes (success or max iterations):
```markdown
# Auto Debug Report

## Issue
[original problem description]

## Iterations
| # | Phase | Action | Result |
|---|-------|--------|--------|
| 1 | DETECT | ran sprint mode | error in task parser |
| 1 | DIAGNOSE | JSON parse failure at task-parser.ts:42 | confidence: high |
| 1 | FIX | added safeJsonParse fallback | APPLIED (user approved) |
| 1 | VERIFY | re-ran same scenario | PASS |

## Root Cause
[explanation]

## Fix Applied
[file + diff summary]

## Regression Check
- typecheck: pass
- tests: 475 pass, 0 fail
- original scenario: pass
```

## Safety Gates

1. ALWAYS ask user before modifying source code
2. NEVER apply fix without running typecheck + tests after
3. NEVER retry same fix more than 2 times
4. NEVER modify more than 3 files in a single fix
5. STOP after 5 total iterations regardless of outcome
6. NEVER delete existing functionality to "fix" a bug
7. ALWAYS show the diff before applying
8. ALWAYS re-run the exact same scenario to verify

## Circuit Breaker Conditions (STOP immediately)

- 3 consecutive iterations with no file changes -> stuck
- Same error text appears 3 times -> fix approach is wrong
- Test count drops (fix broke something) -> revert and stop
- Fix touches > 5 files -> too complex, needs human planning

## Integration with OpenPawl Debug Logs

The debug logs are the primary diagnostic tool. Pattern:
1. --level error -> find the failure
2. --timeline -> understand sequence
3. --source <X> -> zoom into failing subsystem
4. --source llm -> check prompt/response quality
5. --grep <keyword> -> find specific events

## Example Usage

User says: "Sprint mode fails on task 3 with JSON parse error"

Iteration 1:
- DETECT: `OPENPAWL_DEBUG=true openpawl run --headless --mode sprint --goal "Build auth" --workdir /tmp/debug-1`
- DIAGNOSE: `openpawl logs debug --level error` -> "safeJsonParse: all 6 layers failed at sprint-runner.ts:142"
- Look at LLM response: `openpawl logs debug --source llm --event response | tail -1`
  -> Model returned HTML instead of JSON
- ROOT CAUSE: planner prompt doesn't specify JSON output format
- FIX: add "Respond in JSON format only" to PLANNER_PROMPT
- ASK USER -> approved
- VERIFY: re-run same scenario -> task 3 completes -> DONE
