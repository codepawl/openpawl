# OpenPawl Debug Patterns

## When to use
When diagnosing bugs, investigating failures, or understanding
unexpected behavior.

## Quick Diagnosis Commands

### "Why did the sprint fail?"
```bash
OPENPAWL_DEBUG=true openpawl run --headless --mode sprint \
  --goal "..." --workdir /tmp/debug-sprint --runs 1
openpawl logs debug --source sprint --level error
openpawl logs debug --source sprint --event "task:fail"
```

### "Why is it slow?"
```bash
OPENPAWL_PROFILE=true OPENPAWL_DEBUG=true openpawl run --headless \
  --mode solo --goal "..." --workdir /tmp/debug-perf
cat ~/.openpawl/profile-report.md
openpawl logs debug --source llm | grep duration
```

### "Why did the agent write bad code?"
```bash
openpawl logs debug --source llm --event "request"
# Check: what prompt did it receive?
# Check: was memory context injected?
# Check: were lessons included?
```

### "Why is collab not triggering?"
```bash
openpawl logs debug --source router --event "dispatch:start"
# Check: mode field, chain definition
# Check: was buildCollabChain called?
openpawl logs debug --source router --event "collab"
```

### "Why is status bar stuck on idle?"
```bash
openpawl logs debug --source tui --event "status"
# Check: state transitions
# If no entries: events not reaching TUI wiring
```

### "Why did memory not help?"
```bash
openpawl logs debug --source memory
# Check: was retrieval called?
# Check: results count and scores
# Check: was context injected into prompt?
openpawl logs debug --source llm --event "memory_context"
```

## Common Bugs and Fixes

### Raw JSON in tool output
Cause: diff object passed as text instead of through renderer
Fix: check formatToolResult() is called before display
Files: tool-call-view.ts, messages.ts

### Broken newlines during streaming
Cause: word wrap recalculated on partial chunks
Fix: buffer until paragraph boundary or stream end
Files: messages.ts, markdown.ts

### Config not syncing across views
Cause: reading from different sources
Fix: all reads go through globalConfig, emit change event on write
Files: global-config.ts, settings-view.ts, model-view.ts

### Sprint dependency cascade
Cause: hard dependency skip on any failure
Fix: soft deps (attempt if partial output exists) + single retry
Files: sprint-runner.ts

### Token counter not showing
Cause: dispatch:done handler overwritten by another handler
Fix: check handler chain, ensure token segment not clobbered
Files: router-wiring.ts, agent-display.ts
