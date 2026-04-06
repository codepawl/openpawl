# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenPawl orchestrates AI agent teams via LangGraph. Users define goals and teams; agents collaborate to complete them. Multi-run mode learns from failed runs via RAG (LanceDB). Pure team coordination, no economics.

## Commands

- Runtime: Node **>= 20**, **bun**.
- `bun install` — install deps (run if `node_modules` missing or `vitest not found`)
- `bun run build` — build (via tsup, includes web client)
- `bun run typecheck` — type-check
- `bun run test` — tests (Vitest)
- `bun run test -- path/to/file.test.ts` — run a single test file
- `bun run test:watch -- path/to/file.test.ts` — watch a single test file
- `bun run lint` — lint (`eslint src/`)
- `bun run dev` — watch mode
- `bun run web` — web UI (http://localhost:8000)
- `bun run work` — work sessions with web dashboard
- Makefile: `make check` (typecheck + test), `make test-full` (typecheck + lint + test + build — used in CI/pre-commit), `make clean`

## Architecture

### LangGraph Simulation (src/core/simulation.ts)

12-node orchestration graph. Linear pipeline feeds into a looping execution phase:

```
__start__ → memory_retrieval → sprint_planning → system_design → rfc_phase → coordinator → preview_gate
```

From `preview_gate`, conditional edges fan out:
- `preview_gate` → approval | worker_task | worker_collect | END
- `approval` → coordinator (feedback) | worker dispatch
- `worker_task` → `confidence_router` → `worker_collect` → `partial_approval` → `increment_cycle` → coordinator (loop) | END

The `increment_cycle` node terminates via `__end__` when `timeoutMs` elapsed or `maxRuns` reached.

### Graph State (src/core/graph-state.ts)

`GameStateAnnotation` defines all shared state. Key fields: `task_queue` (merge-by-task_id reducer), `cycle_count`, `team`, `bot_stats`, `planning_document`, `architecture_document`, `rfc_document`, `approval_pending/response`, `ancestral_lessons`, `preview`, `messages` (concat reducer). Nodes return `Partial<GraphState>` with only changed keys.

### Agent Pattern

Each LangGraph node receives `GraphState`, returns `Partial<GraphState>`. All nodes set `__node__: "node_name"` for streaming identification. Agent implementations live in `src/agents/` and are wrapped by node factories in `src/graph/nodes/`.

### Work Session Flow (src/work-runner.ts)

1. **Init** — resolve goal, validate gateway health, load team config, init vector memory
2. **Multi-run loop** — for each run: initialize providers, create `TeamOrchestration`, stream execution chunks (each has `__node__`), update dashboard, learn from failures via PostMortemAnalyst, persist success patterns
3. **Cleanup** — stop services, export audit trail, generate CONTEXT.md handoff, run retrospective if rework detected

### Web Server (src/web/server.ts)

Fastify + SSE for real-time dashboard updates. Single active orchestration at a time. `broadcast()` sends events to all SSE clients. Key endpoints: `GET /api/events` (SSE stream), `POST /api/session/start`, `GET /api/config`, `/proxy/*` (SSE proxy to avoid CORS).

### Superpowers Modules

- `src/think/` — Multi-round deliberation sessions for complex reasoning
- `src/clarity/` — Goal clarity analysis (vague verbs, missing success criteria); suggests rewrites
- `src/drift/` — Detects conflicts between original goal and actual task execution
- `src/journal/` — Decision journal; tracks critical decisions, checks for supersession/contradictions
- `src/briefing/` — Session briefing: prior run summaries, team performance, left-open items
- `src/handoff/` — Generates CONTEXT.md handoff from final state (left-to-do, resume commands)
- `src/personality/` — Agent personality injection (traits, communication styles, pushback detection)

### LLM & Memory

- LLM requests route through configured providers (Anthropic, OpenAI, etc.).
- Vector memory via embedded LanceDB. Success patterns and failure lessons persist across runs.

## Code Style

- TypeScript (ESM, built with tsup). Strict typing; no `any`, no `@ts-nocheck`.
- Brief comments for non-obvious logic only.
- Keep files under ~700 LOC; extract helpers over duplicating.
- Naming: **OpenPawl** in docs/headings; `openpawl` for CLI/package.

## Testing

- Vitest. Test files: `tests/*.test.ts` or colocated `src/**/*.test.ts`.
- Run `bun run test` before pushing when touching logic.

## Commits & PRs

- Concise action-oriented messages (e.g. `fix: add reducer to graph-state Annotation`).
- Group related changes; don't bundle unrelated refactors.
- **Auto-commit cadence:** Commit and push after each major logical unit of work (new feature, bug fix, refactor). Do NOT wait until the entire task is done — commit at natural milestones. Aim for commits in the ~200-1000 lines changed range. Avoid micro-commits for trivial edits (typos, single-line fixes) and avoid mega-commits with 2000+ lines.
- **Pre-commit safety checks:** Before every commit, run `git status` and `git diff --stat` to review what is staged. Check for accidentally included large files, build artifacts (`dist/`, `node_modules/`), secrets (`.env`, credentials), or binary blobs. If any staged file exceeds 500KB or any folder adds 50+ new files, stop and ask before committing.

## Pre-commit Hook

Located at `.githooks/pre-commit`, installed via `make install-hooks` (sets `core.hooksPath`). Runs typecheck → lint → tests in sequence. All must pass or the commit is blocked.

## Git Notes

- Branch delete blocked? Use `git update-ref -d refs/heads/<branch>`.
- Bulk PR operations (>5): ask for explicit confirmation with count and scope.
- File references: repo-root relative only (e.g. `src/core/simulation.ts:49`).
- GitHub CLI: use `-F - <<'EOF'` for multiline bodies; never `\"\\n\"` or `-b "..."` with backticks/shell chars.
- GitHub linking: plain `#123` for auto-links (no backticks). Print full URL at end of issue/PR tasks.
- Verify answers in code; do not guess.

## Security

- Never commit real credentials/tokens. Use `.env` from `.env.example`.
- Dashboard server has no built-in auth. Bind to `127.0.0.1` or trusted network.

## Agent-Specific Notes

- Never edit `node_modules`.
- **Multi-agent safety:** no stash create/apply/drop unless requested. No branch switching unless requested. Scope commits to your changes only. On push, `git pull --rebase` to integrate. Focus reports on your edits.
- Formatting-only diffs: auto-resolve without asking. Only ask on semantic changes.
- Bug investigations: read source before concluding; aim for high-confidence root cause.
- No dependency patching or version bumps without explicit approval.

## Tech Stack

LangGraph.js, Zod, Fastify + SSE, LanceDB, Provider Manager, tsup, Vitest. Web client: React + Tailwind CSS. No Python.
