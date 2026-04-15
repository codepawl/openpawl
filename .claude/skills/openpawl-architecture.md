# OpenPawl Architecture Reference

## When to use
When modifying OpenPawl internals, understanding data flow,
or debugging cross-module issues.

## Data Flow: Solo Mode
1. User types prompt in TUI editor
2. input-handler.ts -> prompt-handler.ts
3. PromptRouter.route() -> dispatch strategy
4. dispatch_single -> LLMAgentRunner.run()
5. getMemoryContext() -> inject patterns + decisions
6. callLLMMultiTurn() -> streaming chunks -> TUI
7. Tool calls: file_write/read/edit/shell_exec
8. Each tool: before -> execute -> after -> diff
9. Response complete -> session save -> token update

## Data Flow: Collab Mode
1. Same as solo steps 1-3
2. buildCollabChain(prompt) -> chain definition
3. For each step in chain:
   a. Agent receives: original prompt + all prior outputs
   b. Agent executes with tools
   c. Output captured for next agent
4. Final agent output shown to user
5. All outputs visible as separate agent bubbles

## Data Flow: Sprint Mode
1. resolveTeamContext() -> template or autonomous
2. analyzeGoal() if autonomous -> team composition
3. Planner LLM call -> task list (parsed by task-parser)
4. Task validation (filter invalid, check questions)
5. Build dependency graph -> execution rounds
6. For each round: parallel execute tasks (Promise.all, max 3)
7. Failed tasks: retry once with error context
8. Post-mortem: analyzeRunResult() -> lessons
9. CONTEXT.md generated
10. If --runs > 1: inject lessons -> re-plan -> execute

## Key Patterns

### Safe JSON Parsing
Always use safeJsonParse() for LLM output:
```typescript
import { safeJsonParse } from "../utils/safe-json-parse.js";
const result = safeJsonParse<TaskList>(llmOutput);
if (!result.parsed) { /* handle gracefully */ }
```

### Event System
Use typed enums from event-types.ts:
```typescript
router.on(RouterEvent.AgentStart, handler);
runner.on(SprintEvent.TaskComplete, handler);
```
Never use string literals for events.

### Debug Logging
```typescript
import { debugLog } from "../debug/logger.js";
debugLog("info", "sprint", "task:start", { data: { taskId, agent } });
```
No-op when OPENPAWL_DEBUG is not set.

### Tool Results with Diff
file_write and file_edit return diff data.
Use formatToolResult() to display, never JSON.stringify.

## Common Pitfalls
- Status bar not updating: check event emitter instance match
- Session blank on load: check message replay in session-helpers
- Token counter not showing: check dispatch:done handler chain
- Diff showing raw JSON: formatToolResult not called
- Config not syncing: use writeGlobalConfig + emit change event
