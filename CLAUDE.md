# CLAUDE.md

## Project Overview

OpenPawl orchestrates AI agent teams for coding tasks. Three execution
modes: solo (single agent), collab (multi-agent chain), sprint (full
pipeline with parallel tasks). Memory persists across sessions via
LanceDB. Post-mortem learning improves subsequent runs.

## Commands

- Runtime: Node >= 20, bun
- `bun install` — install deps
- `bun run build` — build (tsup + web client)
- `bun run typecheck` — type-check
- `bun run test` — tests (475 passing)
- `bun run lint` — lint
- `bun run dev` — watch mode

Testing:
- `bun run tsx src/testing/prompt-quality-test.ts` — test agent prompts
- `bun run tsx src/testing/session-test.ts` — session CRUD + perf
- `bun run tsx src/testing/stress-test.ts` — stress test all subsystems
- `bun run tsx src/testing/provider-test.ts` — provider connectivity
- `bun run benchmark` — orchestration benchmarks (scripts/testing/benchmark.ts)

Headless:
- `openpawl run --headless --mode solo|collab|sprint --goal "..." [--template id] [--workdir path] [--runs N]`

Debug:
- `OPENPAWL_DEBUG=true openpawl run --headless ...` — structured JSONL logs
- `openpawl logs debug --timeline` — view debug logs
- `OPENPAWL_PROFILE=true openpawl run --headless ...` — performance profiling

## Architecture

### Entry Points
- src/cli.ts — CLI command registration
- src/app/index.ts — TUI app orchestrator (226 lines, delegates to 13 sub-modules)
- src/app/headless.ts — headless mode (solo/collab/sprint)

### App Sub-modules (split from index.ts)
- src/app/init-session-router.ts — session + router + memory initialization
- src/app/router-wiring.ts — router events → TUI wiring
- src/app/input-handler.ts — editor submit, prompt queue, abort
- src/app/config-wiring.ts — provider config, connection state
- src/app/keybindings-setup.ts — keyboard shortcuts
- src/app/session-helpers.ts — session replay, picker
- src/app/prompt-handler.ts — handleWithRouter, chat fallback
- src/app/tool-permission.ts — tool approval UX
- src/app/welcome.ts — welcome banner + briefing
- src/app/tui-callbacks.ts — TUI events, navigation, cleanup
- src/app/agent-display.ts — agent colors, token formatting
- src/app/startup.ts — debug timing

### Router (src/router/)
- prompt-router.ts — mode routing (solo/collab/sprint)
- dispatch-strategy.ts — agent dispatch
- llm-agent-runner.ts — multi-turn tool-use loop
- collab-dispatch.ts — multi-agent chain (coder→reviewer→coder)
- event-types.ts — typed event enums (RouterEvent, SprintEvent, ToolEvent)

### Sprint (src/sprint/)
- sprint-runner.ts — task execution with soft deps + retry
- task-parser.ts — parse planner output into tasks
- post-mortem.ts — rule-based failure analysis
- goal-analyzer.ts — autonomous team composition
- team-resolver.ts — template → agent mapping
- create-sprint-runner.ts — factory

### Engine (src/engine/)
- llm.ts — LLM calling with context compression, parallel tool exec

### Memory (src/memory/)
- global/store.ts — GlobalMemoryManager (LanceDB)
- hybrid-retriever.ts — vector search + reranking
- hebbian/ — associative learning
- success/ — success pattern storage

### Templates (src/templates/)
- types.ts — OpenPawlTemplate, TemplateAgent, TeamComposition
- template-store.ts — combined built-in + installed store
- seeds/ — 5 built-in templates

### TUI (src/tui/)
- core/tui.ts — main TUI engine
- components/ — messages, editor, status-bar, scrollable-filter-list,
  tool-call-view, status-indicator
- constants/icons.ts — centralized Unicode symbols
- keybindings/input-shortcuts.ts — centralized text editing shortcuts

### Flagship Features
- src/journal/ — decision journal with drift detection
- src/drift/ — goal vs decision conflict detection
- src/briefing/ — session briefing ("previously on...")
- src/handoff/ — CONTEXT.md auto-generation
- src/think/ — rubber duck mode (multi-perspective debate)
- src/standup/ — daily standup generation

### Debug (src/debug/)
- logger.ts — structured JSONL debug logging
- wiring.ts — event listener attachment

### Utils
- src/utils/diff.ts — LCS line diff engine
- src/utils/safe-json-parse.ts — 6-layer JSON recovery
- src/utils/formatters.ts — shared formatters (tokens, duration, bytes)

## Three Execution Modes

Solo: user prompt → single agent → tools → response
Collab: user prompt → agent chain (coder→reviewer→coder) → response
Sprint: goal → planner → parallel tasks → post-mortem → lessons

## Code Style

- TypeScript ESM, strict typing, no `any`
- Files under 700 LOC
- Use theme colors (not hardcoded ctp.* or hex)
- Use ICONS from src/tui/constants/icons.ts
- Use formatters from src/utils/formatters.ts
- Use safeJsonParse for any LLM output parsing
- Use event-types.ts enums for all events (no string literals)
- Debug logging: `debugLog(level, source, event, data)` pattern

## Testing

- 475 tests passing
- Test before pushing when touching logic
- Use OPENPAWL_DEBUG=true for debugging
- Use OPENPAWL_PROFILE=true for performance

## Commits & PRs

- Concise messages: `type(scope): description`
- 200-1000 lines per commit
- Branch off staging, merge via PR
- Pre-commit: typecheck → lint → tests

## Git Workflow

### Branch strategy

```
main ← production, tagged releases only
  └── staging ← integration branch, sprint accumulator
        ├── feat/setup-wizard-tui ← feature branch (auto-created, auto-merged, auto-deleted)
        ├── fix/scroll-performance
        ├── feat/oauth-providers
        └── ...
```

### Branch lifecycle (FOLLOW THIS EVERY TIME)

**Before starting any task:**
1. `git checkout staging && git pull origin staging`
2. Create a topic branch: `git checkout -b <type>/<short-name>`
   - Types: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`
3. One branch = one theme. Multiple commits OK, but all related to the same topic.

**While working:**
4. Commit at natural milestones (~200-1000 lines changed)
5. Commit messages: `type: concise description`

**When task is complete:**
6. Run full CI checks locally: `bun run typecheck && bun run lint && bun run test`
7. If ANY check fails → fix it on the same branch → re-run checks
8. Merge into staging: `git checkout staging && git merge --no-ff <branch-name>`
9. Push staging: `git push origin staging`
10. Delete the topic branch

**NEVER skip steps 6-7. NEVER merge with failing checks.**

### Semantic versioning
- patch: bug fixes, perf
- minor: new features, commands, UI
- major: breaking changes

### Rules
- Never commit directly to main or staging
- Always create topic branch per task
- Always delete topic branches after merge
- Never force push main or staging

## Pre-commit Hook

Located at `.githooks/pre-commit`, installed via `make install-hooks`. Runs typecheck → lint → tests in sequence.

## Git Notes

- Branch delete blocked? Use `git update-ref -d refs/heads/<branch>`.
- Bulk PR operations (>5): ask for explicit confirmation.
- File references: repo-root relative only.
- GitHub CLI: use `-F - <<'EOF'` for multiline bodies.
- Verify answers in code; do not guess.

## Security

- Never commit real credentials/tokens. Use `.env` from `.env.example`.
- Dashboard server has no built-in auth. Bind to `127.0.0.1` or trusted network.

## Agent-Specific Notes

- Never edit `node_modules`.
- Multi-agent safety: no stash, no branch switching unless requested. Scope commits to your changes only.
- Bug investigations: read source before concluding; aim for high-confidence root cause.
- No dependency patching or version bumps without explicit approval.

## Tech Stack

TypeScript (ESM), Bun, tsup, Zod, LanceDB, cli-highlight. Multi-provider LLM (Anthropic SDK, OpenAI-compatible, Bedrock, Vertex). No Python.
