# Guidelines

- File references: repo-root relative only (e.g. `src/core/simulation.ts:49`).
- GitHub CLI: use `-F - <<'EOF'` for multiline bodies; never `\"\\n\"` or `-b "..."` with backticks/shell chars.
- GitHub linking: plain `#123` for auto-links (no backticks). Print full URL at end of issue/PR tasks.
- Verify answers in code; do not guess.

## Project Overview

TeamClaw orchestrates AI agent teams via LangGraph. Users define goals and teams; agents collaborate to complete them. Multi-run mode learns from failed runs via RAG (LanceDB). Pure team coordination, no economics.

## Structure

- `src/cli.ts` — CLI entry point
- `src/core/` — State, config, LangGraph simulation, knowledge-base, team templates, LLM client, workspace/session management
- `src/agents/` — Coordinator, WorkerBot, Analyst, Approval, Planning, Retrospective, RFC, SystemDesign, MemoryRetrieval
- `src/commands/` — CLI subcommands (config, setup, status, run-openclaw)
- `src/config/` — Config UI
- `src/interfaces/` — Worker adapter, WebSocket events
- `src/web/` — Fastify + WebSocket server; `static/` + `client/` for web UI
- `src/daemon/` — Background process manager
- `src/onboard/` — Interactive onboarding
- `src/utils/` — JSON extraction, log rotation, path autocomplete
- `src/work-runner.ts` — Work session logic
- `src/check.ts` — Connectivity check
- `tests/` — Vitest tests
- `docs/`, `dist/` — Documentation, build output

### Agent Pattern

Each LangGraph node receives `GraphState`, returns `Partial<GraphState>` (changed keys only). Nodes include `__node__` for streaming identification.

### RAG & LLM

- Vector memory via embedded LanceDB.
- LLM requests route through OpenClaw (`OPENCLAW_WORKER_URL`, `OPENCLAW_TOKEN`).

## Commands

- Runtime: Node **>= 20**, **pnpm**.
- `pnpm install` — install deps (run if `node_modules` missing or `vitest not found`)
- `pnpm run build` — build (via tsup)
- `pnpm run typecheck` — type-check
- `pnpm run test` / `pnpm run test:watch` — tests (Vitest)
- `pnpm run lint` — lint
- `pnpm run dev` — watch mode
- `pnpm run web` — web UI (http://localhost:8000)
- `pnpm run work` — work sessions with web dashboard
- Makefile: `make install`, `make check` (typecheck + test), `make lint`, `make web`, `make work`, `make clean`

## Code Style

- TypeScript (ESM, built with tsup). Strict typing; no `any`, no `@ts-nocheck`.
- Brief comments for non-obvious logic only.
- Keep files under ~700 LOC; extract helpers over duplicating.
- Naming: **TeamClaw** in docs/headings; `teamclaw` for CLI/package.

## Testing

- Vitest. Test files: `tests/*.test.ts` matching source names.
- Run `pnpm run test` before pushing when touching logic.

## Commits & PRs

- Concise action-oriented messages (e.g. `fix: add reducer to graph-state Annotation`).
- Group related changes; don't bundle unrelated refactors.

## Git Notes

- Branch delete blocked? Use `git update-ref -d refs/heads/<branch>`.
- Bulk PR operations (>5): ask for explicit confirmation with count and scope.

## Security

- Never commit real credentials/tokens. Use `.env` from `.env.example`.

## Agent-Specific Notes

- Never edit `node_modules`.
- **Multi-agent safety:** no stash create/apply/drop unless requested. No branch switching unless requested. Scope commits to your changes only. On push, `git pull --rebase` to integrate. Focus reports on your edits.
- Formatting-only diffs: auto-resolve without asking. Only ask on semantic changes.
- Bug investigations: read source before concluding; aim for high-confidence root cause.
- No dependency patching or version bumps without explicit approval.

## Tech Stack

LangGraph.js, Zod, Fastify + WebSocket, LanceDB, OpenClaw Gateway, tsup. No Python.
