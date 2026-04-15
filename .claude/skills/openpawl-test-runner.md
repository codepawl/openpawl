# OpenPawl Test Runner Skill

## When to use
When testing OpenPawl features, debugging issues, or verifying fixes.

## How to run OpenPawl

### Headless mode (preferred for testing):
```bash
OPENPAWL_DEBUG=true openpawl run --headless \
  --mode <solo|collab|sprint> \
  --goal "<goal text>" \
  --workdir ~/personal/openpawl-test-projects/<test-name> \
  [--template <template-id>] \
  [--runs <N>]
```

### Read debug logs after run:
```bash
# Latest session logs
cat ~/.openpawl/debug/$(ls -t ~/.openpawl/debug/ | head -1)

# Filter errors only
cat ~/.openpawl/debug/$(ls -t ~/.openpawl/debug/ | head -1) | jq 'select(.level == "error")'

# Filter by source
cat ~/.openpawl/debug/$(ls -t ~/.openpawl/debug/ | head -1) | jq 'select(.source == "sprint")'

# Timeline of events
cat ~/.openpawl/debug/$(ls -t ~/.openpawl/debug/ | head -1) | jq '{time: .timestamp, event: .event, source: .source, error: .error}'
```

### Use the built-in log viewer:
```bash
# Latest session, last 50 entries
openpawl logs debug

# Compact timeline view
openpawl logs debug --timeline

# Filter by level
openpawl logs debug --level error

# Filter by source (router, sprint, tool, llm, memory, session, error, tui)
openpawl logs debug --source sprint

# Filter by event name
openpawl logs debug --event task:start

# Search across all fields
openpawl logs debug --grep "file_write"

# Raw JSON for piping
openpawl logs debug --json | jq .

# Follow live
openpawl logs debug -f
```

### Check output:
```bash
# What files were created
ls -la ~/personal/openpawl-test-projects/<test-name>/

# Check CONTEXT.md
cat ~/personal/openpawl-test-projects/<test-name>/CONTEXT.md

# Profile report (if OPENPAWL_PROFILE=true)
cat ~/.openpawl/profile-report.md
```

## Test scenarios

### Scenario 1: Solo chat
```bash
OPENPAWL_DEBUG=true openpawl run --headless --mode solo \
  --goal "Create a hello world Express server" \
  --workdir ~/personal/openpawl-test-projects/test-solo
```
Expected: 1 agent, 1 file created, < 60s

### Scenario 2: Collab mode
```bash
OPENPAWL_DEBUG=true openpawl run --headless --mode collab \
  --goal "implement rate limiting middleware for Express.js" \
  --workdir ~/personal/openpawl-test-projects/test-collab
```
Expected: coder -> reviewer -> coder chain, reviewed code

### Scenario 3: Sprint mode
```bash
OPENPAWL_DEBUG=true openpawl run --headless --mode sprint \
  --goal "Build a REST API with JWT auth and rate limiting" \
  --workdir ~/personal/openpawl-test-projects/test-sprint \
  --runs 1
```
Expected: planner -> tasks -> parallel coders -> post-mortem

### Scenario 4: Sprint with template
```bash
OPENPAWL_DEBUG=true openpawl run --headless --mode sprint \
  --template indie-hacker \
  --goal "Build a CLI task manager with add/list/delete" \
  --workdir ~/personal/openpawl-test-projects/test-template \
  --runs 2
```
Expected: template agents used, run 2 applies lessons from run 1

### Scenario 5: Stress test
```bash
OPENPAWL_DEBUG=true OPENPAWL_PROFILE=true openpawl run --headless \
  --mode sprint \
  --goal "Build a complete REST API with auth, rate limiting, health, CRUD for todos, and full test suite" \
  --workdir ~/personal/openpawl-test-projects/test-stress \
  --runs 2
```
Expected: 10+ tasks, parallel execution, post-mortem learning

## Debug workflow

1. Run a scenario
2. If it fails or output is wrong:
   a. Read debug logs: filter errors first, then timeline
   b. Identify: which event/source failed?
   c. Read the source file for that event handler
   d. Propose fix (ALWAYS ask user before applying)
   e. Apply fix, re-run same scenario
   f. Compare logs: is the error gone?
3. If output is correct but quality is poor:
   a. Read debug logs: check LLM prompts and responses
   b. Check: are prompts well-structured?
   c. Check: is context being passed correctly between agents?
   d. Propose prompt improvement (ask user first)

## Log analysis patterns

### Find why a task failed:
```bash
cat <logfile> | jq 'select(.source == "sprint" and .event == "task:fail")'
```

### Find slow operations:
```bash
cat <logfile> | jq 'select(.duration > 5000) | {event, source, duration}'
```

### Find LLM token usage:
```bash
cat <logfile> | jq 'select(.source == "llm") | {event, data.inputTokens, data.outputTokens}'
```

### Find tool errors:
```bash
cat <logfile> | jq 'select(.source == "tool" and .level == "error")'
```

### Full event timeline:
```bash
cat <logfile> | jq -r '"\(.timestamp | split("T")[1] | split(".")[0]) [\(.source)] \(.event) \(if .error then "ERROR: " + .error else "" end)"'
```

## Rules
- ALWAYS run with OPENPAWL_DEBUG=true when testing
- ALWAYS read logs before proposing fixes
- ALWAYS ask user before modifying source code
- NEVER modify test assertions to hide failures
- NEVER skip re-running the scenario after a fix
- Compare logs before and after fix to verify
