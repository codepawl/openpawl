# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenPawl orchestrates AI agent teams for coding tasks via a TUI. Two app
modes: **solo** (single agent) and **crew** (multi-agent — scaffolding
removed in `2a22da9`, full implementation in progress on
`chore/nuke-sprint-scaffold-crew`). Memory persists across sessions via
LanceDB. Decision journal, drift detection, post-mortem learning, and
session briefing keep context alive between runs.

## Commands

Runtime: Node >= 20, Bun.

- `bun install` — install deps (workspace: root, `src/web/client`, `packages/*`)
- `bun run build` — `tsup` + web client build
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — `eslint src/`
- `bun run test` — Bun test runner (467 tests across 44 files)
- `bun run test:e2e` — `tests/e2e/` only
- `bun run test:watch` / `bun run test:coverage`
- `bun run dev` — tsup watch mode
- `bun run dev:cli` / `dev:work` / `dev:web` — tsx-driven entry points
- `bun run benchmark` — `scripts/testing/benchmark.ts`

Out-of-band test scripts (live in `scripts/testing/`, not `src/testing/`):
- `bun run tsx scripts/testing/prompt-quality-test.ts`
- `bun run tsx scripts/testing/session-test.ts`
- `bun run tsx scripts/testing/stress-test.ts`
- `bun run tsx scripts/testing/provider-test.ts`

Headless run: `openpawl run --headless --goal "..." [--runs N] [--mode solo] [--workdir path]`. Only `--mode solo` is wired today.

Debug:
- `OPENPAWL_DEBUG=true openpawl ...` — structured JSONL logs
- `openpawl logs debug --timeline` — view debug logs
- `OPENPAWL_PROFILE=true openpawl ...` — performance profiling
- `OPENPAWL_DEBUG_STARTUP=1` — print stage timings to stderr from `cli.ts`

## CLI Surface

Top-level commands (see `src/cli/command-registry.ts` for the source of truth):

`setup`/`init`, `check`, `demo`, `solo`/`chat`, `standup`, `think`,
`clarity`, `journal`, `drift`, `lessons`, `handoff`, `templates`,
`model`, `providers`, `agent`, `settings`, `config`, `replay`, `audit`,
`heatmap`, `forecast`, `diff`, `score`, `sessions`, `memory`, `cache`,
`logs`, `profile`, `clean`, `update`, `uninstall`.

Primary interactive entry point is `openpawl work` (alias for the TUI session).

## Architecture

### Entry Points
- `src/cli.ts` (~380 lines) — CLI bootstrap, proxy auto-detection, command dispatch
- `src/cli/command-registry.ts` — single registry of all CLI commands
- `src/app/index.ts` (226 lines) — TUI app orchestrator, delegates to ~13 sub-modules
- `src/app/headless.ts` — headless solo runs

### App sub-modules (`src/app/`)
`init-session-router.ts`, `router-wiring.ts`, `input-handler.ts`,
`config-wiring.ts`, `keybindings-setup.ts`, `session-helpers.ts`,
`prompt-handler.ts`, `tool-permission.ts`, `welcome.ts`,
`tui-callbacks.ts`, `agent-display.ts`, `startup.ts`, `layout.ts`,
`autocomplete.ts`, `file-ref.ts`, `shell.ts`, `config-check.ts`.

### Router (`src/router/`)
`prompt-router.ts` (mode dispatch), `dispatch-strategy.ts`,
`llm-agent-runner.ts` (multi-turn tool-use loop),
`agent-config.ts`/`agent-registry.ts`/`agent-resolver.ts`,
`intent-classifier.ts`, `mention-parser.ts`,
`event-types.ts` (typed `RouterEvent` / `ToolEvent` enums — never use string literals).

### Engine (`src/engine/`)
`llm.ts` — LLM call loop with context compression and parallel tool execution.

### Memory (`src/memory/`)
- `global/store.ts` — `GlobalMemoryManager` (LanceDB)
- `hybrid-retriever.ts` — vector search + reranking
- `hebbian/` + `hebbian-integration.ts` — associative learning
- `success/` — success-pattern storage

### Templates (`src/templates/`)
- `types.ts` — `OpenPawlTemplate`, `TemplateAgent`, `TeamComposition`
- `template-store.ts` — combined built-in + installed store
- `seeds/index.ts` — 5 built-in templates inline (content-creator, indie-hacker, research-intelligence, business-ops, full-stack-sprint)

### TUI (`src/tui/`)
`core/tui.ts` (engine), `components/`, `constants/icons.ts`,
`keybindings/input-shortcuts.ts`, `keybindings/app-mode.ts`
(defines `AppMode = "solo" | "crew"`), `themes/`, `primitives/`,
`slash/`, `text/`, `autocomplete/`, `keyboard/`, `layout/`.

### Flagship features (top-level dirs)
- `journal/` — decision journal (`extractor`, `store`, `supersession`)
- `drift/` — goal vs decision conflict detection
- `briefing/` — "previously on..." session briefing
- `handoff/` — `CONTEXT.md` auto-generation + resume
- `think/` — multi-perspective debate (rubber duck)
- `standup/` — daily standup generation
- `audit/` — sprint/run auditing + renderers
- `clarity/` — goal clarity analyzer + rewriter
- `forecast/` — cost/run forecast with learning discount
- `heatmap/` — agent performance visualization
- `score/` — vibe coding collaboration score
- `replay/` — session recording + diff/replay
- `research/` — research agent + change-agent
- `recovery/` — crash handler + error presenter
- `personality/` — agent personality injection
- `clarification/` (`conversation/`) — clarification dialogs + undo
- `onboard/` — first-run setup flow
- `agents/profiles/` — agent profile store
- `debate/`, `forecast/methods`, `graph/preview` — newer subsystems

### Other infrastructure
- `cache/` — response cache + interceptor
- `proxy/` — `ProxyService`
- `security/` — prompt injection detector
- `telemetry/`, `token-opt/`, `meta/`, `dev/`, `webhook/`
- `web/` — dashboard server + `client/` (separate workspace)
- `tools/` — tool executor, registry, permissions, `built-in/`
- `providers/`, `credentials/`, `session/`, `core/` (config, logger, errors, sandbox)
- `debug/logger.ts` + `debug/wiring.ts` — structured JSONL logging
- `utils/diff.ts` (LCS), `utils/safe-json-parse.ts` (6-layer JSON recovery), `utils/formatters.ts`

## App Modes

- **Solo**: prompt → single agent → tools → response
- **Crew**: multi-agent — `prompt-router.ts` currently rejects with "Crew mode not yet implemented" until the new scaffold lands

Shift+Tab cycles modes. The legacy `collab` and `sprint` modes were removed in commit `2a22da9` (`chore(crew): nuke sprint and collab scaffolding`); README still references them but the code does not.

## Code Style

- TypeScript ESM, strict typing, no `any`
- Files under 700 LOC
- Use theme colors from `src/tui/themes/` (not hardcoded `ctp.*` or hex)
- Use `ICONS` from `src/tui/constants/icons.ts`
- Use formatters from `src/utils/formatters.ts`
- Use `safeJsonParse` for any LLM output parsing
- Use `event-types.ts` enums for all router/tool events (no string literals)
- Debug logging: `debugLog(level, source, event, data)`

## Testing

- `bun test` runs the suite (currently 448 pass / 19 skip / 0 fail across 44 files)
- Test before pushing when touching logic
- `OPENPAWL_DEBUG=true` for trace logs, `OPENPAWL_PROFILE=true` for profiling

## Git Workflow

### Branch strategy

```
main ← production, tagged releases only
  └── staging ← integration branch
        └── feat|fix|refactor|chore|docs/<short-name> ← topic branches
```

### Branch lifecycle (FOLLOW EVERY TIME)

Before starting:
1. `git checkout staging && git pull origin staging`
2. `git checkout -b <type>/<short-name>` (types: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`)
3. One branch = one theme.

While working:
4. Commit at natural milestones (~200–1000 lines).
5. Conventional commits: `type(scope): description`, imperative, lowercase, no period, no AI attribution.

When complete:
6. `bun run typecheck && bun run lint && bun run test` — all must pass.
7. Fix on the same branch if anything fails.
8. `git checkout staging && git merge --no-ff <branch>` then `git push origin staging`.
9. Delete the topic branch.

**Never skip steps 6–7. Never merge with failing checks. Never commit directly to `main` or `staging`. Never force-push shared branches.**

### Versioning
- patch: bug fixes, perf
- minor: new features, commands, UI
- major: breaking changes

### Pre-commit hook
`.githooks/pre-commit` runs typecheck → lint → tests. Install with `git config core.hooksPath .githooks` (no Makefile in repo).

### Git utilities
- Branch delete blocked? `git update-ref -d refs/heads/<branch>`
- Bulk PR operations (>5): ask for explicit confirmation
- File references: repo-root relative
- Multiline `gh` bodies: `-F - <<'EOF'`

## Security

- Never commit real credentials/tokens; copy `.env.example` → `.env`
- Dashboard server has no built-in auth — bind to `127.0.0.1` or trusted networks only

## Agent-Specific Notes

- Never edit `node_modules`
- Multi-agent safety: no stash, no branch switching unless requested; scope commits to your changes only
- Bug investigations: read source before concluding; aim for high-confidence root cause
- No dependency patching or version bumps without explicit approval

## Tech Stack

TypeScript (ESM), Bun, tsup, Zod, LanceDB, cli-highlight. Multi-provider LLM (Anthropic SDK, OpenAI-compatible, Bedrock, Vertex). Workspace pulls in `packages/sdk` and `src/web/client`. No Python.
