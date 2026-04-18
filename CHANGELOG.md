# Changelog

## [0.3.0] - 2026-04-18

Sprint correctness and context-sharing release. Closes out a two-day debug session that moved the CLI Task Manager benchmark sprint/solo output-token ratio from **2.08× (pre-PR-74)** to **0.66× (post-PR-84)** — a **68 % reduction**. Sprint is now meaningfully cheaper than solo on the reference benchmark, with honest claim-vs-disk quality.

### Fixed
- **Retry semantics rework** (#77): classifier-backed `isRetriable` skips `env_*` and `timeout` kinds because the same agent in the same environment cannot recover. Eliminated the false-positive retry cascade that previously re-ran tasks blocked by missing deps.
- **Env error classification** (#77): tasks that fail with `exit 127` / command-not-found / missing-dep surface `BLOCKED: <what is missing>` instead of looping through retries. `classifyError`/`classifyTask` prefer exit code over regex.
- **Validator correctness** — two bugs fixed:
  - **Parallel-attribution race** (#78): tool calls now attribute by explicit `taskIndex` threaded through `runAgent` → `handleTool` → `recordToolCall`, replacing the shared `state.currentTaskIndex` that got clobbered under concurrent execution.
  - **Leniency tightened** (#82): `shell_exec` no longer counts as write evidence. Write-intent tasks that only ran reads/shells are now correctly flagged incomplete. Eliminates silent success on tasks that produced no files.
- **Planner misassignment** (#83): LLM planner no longer self-assigns write-intent tasks. Prompt constraint + runtime `downgradePlannerOnWrite` guard reassigns to `coder`. Planner output tokens dropped from 52,445 (85.5 % of run) to 943 (8 %) on the CLI Task Manager benchmark.

### Added
- **Inter-task context sharing** (#84): `TASK_PROMPT` now includes a compact "Files already created" digest listing on-disk files produced by prior completed tasks, each with a ≤100-char hint. Bounded at 500 chars with `…+N more` tail. Eliminates coder cold-start: `src/types.ts` re-reads dropped from 18 to 4 across a 5-task plan.

### Benchmark impact (CLI Task Manager sprint)
| metric | pre-session baseline | post-PR-84 | Δ |
|---|---|---|---|
| output tokens | 22,414 | 10,976 | −51 % |
| sprint/solo output ratio | 2.08× → 0.89× (post-PR-83 partial) | **0.66×** | target <1.2× ✅ |
| `task-1` turns (scaffold) | 20 | 10 | −50 % |
| `src/types.ts` re-reads | 18 | 4 | −78 % |
| retry count pathology | 5 false-positives | 0 | eliminated |

Full trace in `docs/debug/pr83-investigation.md`.

## [0.2.0] - 2026-04-17

Sprint retry-semantics overhaul. Four-PR chain eliminates the env-retry cascade and the parallel-task validator race, delivering a measured **−69 % sprint output tokens** and **−56 % wall time** on the CLI Task Manager benchmark (`docs/debug/pr78-validation.md`). Sprint/solo output-token ratio on the same benchmark: **2.08× → 0.63×** — sprint is now cheaper than solo.

### Fixed
- **Validator parallel-attribution race** (#78): `recordToolCall` previously used a shared `state.currentTaskIndex` that got clobbered by concurrent `executeTask` frames. Tool calls now attribute by explicit `taskIndex` threaded through `runAgent` → `handleTool` → `recordToolCall`. Eliminates false-positive "incomplete" retries under parallel execution.
- **Retry routing preserves original agent** (#69): retries no longer reroute to `debugger` via keyword match on the error message. Attribution now correctly reflects which agent did the work.

### Added
- **Structured `shell_exec` result** (#76): `executeShell` returns `{ exitCode, stdout, stderr }` (previously merged). `ToolOutput.data` carries all three fields typed as `ShellExecData`. `executeTool` callback return type extended with optional `success`, `exitCode`, `stderrHead`. `SprintTask` gains `toolCallResults: SprintToolCallResult[]` alongside existing `toolsCalled`.
- **Error classifier** (#77): new `src/sprint/error-classify.ts` with `ErrorKind` union (`env_command_not_found | env_missing_dep | env_perm | env_port_in_use | timeout | agent_logic | unknown`), `classifyError` (prefers exit code over regex), and `classifyTask` (reads `toolCallResults`). `FAILURE_RULES` moved from `post-mortem.ts` — no regex duplication.
- **Classifier-backed retry gating** (#77): `SprintRunner.isRetriable` consults the classifier first. `env_*` and `timeout` kinds skip retry because the same agent in the same environment cannot recover. Emits `sprint:retry_gate` debug event with `{ taskId, kind, signal, willRetry }`.
- **Agent escalation clause** (#77): coder, tester, debugger, and assistant system prompts now instruct the LLM to stop and emit `BLOCKED: <what is missing>` on `exit 127` / "command not found". Reviewer, planner, and researcher prompts unchanged.
- **Retry root-cause analysis** (#75): new `docs/debug/retry-root-cause-analysis.md` diagnosing the two nested retry loops (model-level LLM turn loop and sprint-level task re-execution) with ranked structural fixes.

### Fixed (bug fixes from the chain)
- `llm-agent-runner.ts` now records `success: false` when a tool returns exit-non-zero, not just when the executor throws. Previously logged `success: true` on `exit 127`.
- `SprintTask.toolCallResults` is reset to `[]` on task retry (previously only `toolsCalled` was reset).
- Thrown-task errors are now enriched with the last shell exit code (`"... (last shell exit ${N})"`) via new `SprintRunner.lastShellFailure` helper.

## [0.1.0] - 2026-04-14

First public release. Major rewrite from v0.0.1: replaced LangGraph pipeline with native API tool calling, added TUI-first interactive mode, removed dead code (11k LOC), and added 15 new features.

### Added
- 3 execution modes: solo, collab, sprint (replaces single LangGraph pipeline)
- Interactive TUI with Catppuccin Mocha theme, mouse support, keyboard navigation
- `/agents` CRUD — create, edit, delete custom agents from TUI
- `/team` view — browse and switch team templates interactively
- `/mode` — switch between solo, collab, sprint with Shift+Tab
- Inline colored diffs on file writes/edits (TUI and headless)
- Escape to cancel any streaming response
- Headless mode: `openpawl run --headless --goal "..." --mode --template --runs --workdir`
- Context compression — automatic compaction keeps context growth < 1x
- Token counter in status bar (live input/output tracking)
- Type-to-filter in all list views (agents, templates, sessions)
- Centralized keybindings with `/hotkeys`
- Post-mortem learning — extracts lessons across runs, injects into future planning
- Hebbian memory — strengthens concept associations based on co-activation
- Autonomous team composition based on goal analysis
- Performance profiler (opt-in timing breakdown)
- Min terminal size handling with graceful degradation
- Provider/model sync as single source of truth

### Changed
- LLM engine: native API tool calling with multi-turn streaming (replaces LangGraph)
- Architecture: prompt router → agent runner → LLM multi-turn loop
- Test runner: Bun test (was Vitest)
- Sprint mode: keyword-based agent assignment (was coordinator-based)

### Removed
- LangGraph dependency and 12-node pipeline
- Standalone dashboard server (Fastify + SSE)
- 153 dead code files (11k LOC): plugins, MCP server, streaming, old setup wizard
- Instructor.js structured output layer
- Langfuse telemetry integration

## [0.0.1] - 2026-03-18

### Added
- Multi-provider LLM support: Anthropic, OpenAI, OpenRouter, Ollama, DeepSeek, Groq
- Provider fallback chain with automatic failover
- Setup wizard with provider configuration
- Template marketplace: browse, install, publish
- 5 seed templates: content-creator, indie-hacker, research-intelligence, business-ops, full-stack-sprint
- 12-node LangGraph orchestration pipeline with parallel worker execution
- Vector memory via embedded LanceDB
- Decision journal, drift detection, standup, replay, heatmap, forecast
- Rubber duck mode, vibe coding score, cost forecasting
- Real-time WebSocket dashboard
