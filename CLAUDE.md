# Repository Guidelines

- Repo: TeamClaw (this repository)
- In chat replies, file references must be repo-root relative only (e.g. `src/core/simulation.ts:49`); never absolute paths or `~/...`.
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or `$'...'`) for real newlines; never embed `"\\n"`.
- GitHub comment footgun: never use `gh issue/pr comment -b "..."` when body contains backticks or shell chars. Always use single-quoted heredoc (`-F - <<'EOF'`) so no command substitution/escaping corruption.
- GitHub linking footgun: don't wrap issue/PR refs like `#123` in backticks when you want auto-linking. Use plain `#123` (optionally add full URL).
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.

## Project Overview

TeamClaw is a team orchestration application. Users define goals and teams (e.g. Game Dev: programmers, artist, SFX), and AI agents collaborate via LangGraph. Optional multi-run mode learns from failed runs via RAG (ChromaDB or JSON fallback). No economics—pure team coordination.

## Project Structure & Module Organization

- Source code: `src/` (CLI in `src/cli.ts`, orchestration in `src/core`, agents in `src/agents`, web in `src/web`, onboarding in `src/onboard`).
- Tests: `tests/` (Vitest). Built output in `dist/`.
- Docs: `docs/`.
- Key modules:
  - **src/core/** — State, config, LangGraph simulation, knowledge-base, team templates
  - **src/agents/** — Coordinator (goal decomposition), WorkerBot (task execution), Analyst (postmortem)
  - **src/interfaces/** — Sparki SDK (RealSparki / MockSparki)
  - **src/web/** — Fastify + WebSocket; streams workflow to `static/terminal.html`
  - **src/work-runner.ts** — Work session logic
  - **src/check.ts** — Connectivity check CLI

### Agent Pattern

Each LangGraph node receives `GraphState` and returns `Partial<GraphState>` (only changed keys). Nodes include `__node__` for streaming identification.

### RAG & LLM

- `VectorMemory`: ChromaDB or `data/vector_store/lessons_fallback.json`.
- TeamClaw routes LLM requests through OpenClaw using `OPENCLAW_WORKER_URL` and `OPENCLAW_TOKEN`.

## Build, Test, and Development Commands

- Runtime: Node **>= 20**. Package manager: **pnpm**.
- Install: `pnpm install`
- If deps missing (`node_modules` empty, `vitest not found`), run `pnpm install`, then retry the command.
- Type-check: `pnpm run typecheck`
- Build: `pnpm run build`
- Lint: `pnpm run lint`
- Tests: `pnpm run test` (Vitest)
- Watch mode: `pnpm run test:watch`, `pnpm run dev`
- Web UI: `pnpm run web` (http://localhost:8000)
- Work sessions: `pnpm run work` (or `teamclaw work --runs 5`)
- Makefile: `make install`, `make check` (typecheck + test), `make lint`, `make web`, `make work`, `make clean`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Never add `@ts-nocheck` or disable `no-explicit-any`; fix root causes.
- Add brief comments for tricky or non-obvious logic.
- Keep files concise; extract helpers instead of duplicating. Aim under ~700 LOC when feasible.
- Naming: **TeamClaw** for product/docs headings; `teamclaw` for CLI command and package.

## Testing Guidelines

- Framework: Vitest.
- Naming: match source with `*.test.ts`; e.g. `tests/state.test.ts`.
- Run `pnpm run test` before pushing when touching logic.
- Do not set test workers above 16 if memory pressure occurs.

## Commit & Pull Request Guidelines

- Follow concise, action-oriented commit messages (e.g. `fix: add reducer to graph-state Annotation`).
- Group related changes; avoid bundling unrelated refactors.
- Issue templates: `.github/ISSUE_TEMPLATE/`
- PR template: add `.github/pull_request_template.md` if desired.

## Git Notes

- If `git branch -d/-D` is policy-blocked, delete ref directly: `git update-ref -d refs/heads/<branch>`.
- Bulk PR close/reopen: if action would affect more than 5 PRs, ask for explicit confirmation with exact count and scope.

## Security & Configuration Tips

- Never commit or publish real credentials, tokens, or live config. Use placeholders in docs, tests, and examples.
- `.env` from `.env.example`; OpenClaw and ChromaDB settings are configurable.

## Agent-Specific Notes

- Never edit `node_modules`. Updates overwrite.
- **Multi-agent safety:** do not create/apply/drop `git stash` unless explicitly requested. Assume other agents may be working.
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest. When "commit", scope to your changes only.
- **Multi-agent safety:** do not switch branches unless explicitly requested.
- **Multi-agent safety:** focus reports on your edits; avoid guard-rail disclaimers unless blocked.
- Lint/format churn: if diffs are formatting-only, auto-resolve without asking. Only ask when changes are semantic.
- Bug investigations: read source of relevant dependencies and local code before concluding; aim for high-confidence root cause.
- Dependency changes: avoid patching (pnpm patches, overrides) unless explicitly approved.
- Version bump: do not change versions without explicit consent.

## Tech Stack

LangGraph.js, Zod, Fastify + WebSocket, ChromaDB (optional), OpenClaw Gateway. No Python.
