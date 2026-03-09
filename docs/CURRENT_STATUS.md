# TeamClaw — Current Status (Agent Handoff)

> **Version:** 0.1.0  
> **Last Updated:** 2026-03  
> **Purpose:** Snapshot for another agent to understand the project and propose ideas.

---

## 1. What TeamClaw Is

TeamClaw orchestrates AI bot teams (programmers, artist, SFX, etc.) via **LangGraph**. Users set a goal; the **Coordinator** decomposes it into subtasks; **WorkerBots** execute tasks via OpenClaw. Optional multi-run mode uses **RAG** (ChromaDB or JSON fallback) to learn from failed runs via **PostMortemAnalyst**.

- **No economics** — pure coordination
- **No Python** — TypeScript only
- **Package manager:** pnpm

---

## 2. Implemented Features

| Feature | Status | Notes |
|--------|--------|-------|
| LangGraph orchestration | Done | coordinator → worker_execute → increment_cycle loop |
| Coordinator (OpenClaw) | Done | Goal decomposition, assigns by role |
| WorkerBot + Sparki SDK | Done | OpenClaw-backed execution |
| Team templates | Done | game_dev, startup, content |
| RAG / VectorMemory | Done | ChromaDB + JSON fallback |
| PostMortemAnalyst | Done | Failure analysis, heuristic lessons |
| Web UI | Done | Fastify + WebSocket, real-time terminal.html |
| CLI work sessions | Done | `teamclaw work`, `--runs N` for multi-run |
| Onboarding wizard | Done | Ink TUI: goal, template, worker URL |
| Config | Done | Web UI, teamclaw.config.json, .env; creativity (0–1) → LLM temp |
| Docker | Done | teamclaw-web + ChromaDB + OpenClaw worker |
| CI/CD | Done | pnpm, lint + typecheck + test matrix (Node 20/22, Ubuntu/Windows) |
| Issue templates | Done | Bug report, feature request |
| PR template | Done | Basic checklist |

---

## 3. Architecture Overview

```
LangGraph flow:
  START → coordinator → [pending tasks?] → worker_execute → increment_cycle →
     ↑         ↓ yes                                         ↓
     └─────────┴──────────────── [continue] ←────────────────┘
                 ↓ no → END
```

**Key files:**
- `src/core/simulation.ts` — TeamOrchestration, graph definition
- `src/core/graph-state.ts` — LangGraph Annotation (lastValue reducers)
- `src/agents/coordinator.ts` — decomposeGoalWithLlm via OpenClaw
- `src/agents/worker-bot.ts` — executeTask, createWorkerExecuteNode
- `src/agents/analyst.ts` — PostMortemAnalyst, heuristic + RAG lessons
- `src/interfaces/sparki-sdk.ts` — RealSparki, MockSparki
- `src/web/server.ts` — Fastify + WebSocket, streams node events to UI
- `src/work-runner.ts` — CLI multi-run loop with lesson learning

**Graph state:** task_queue, team, bot_stats, user_goal, cycle_count, messages, etc. `chaos_events` exists in state but is never populated; no chaos or recharge nodes in the graph.

---

## 4. Test Coverage

- **tests/state.test.ts** — 4 tests: initializeGameState, initializeTeamState, buildTeamFromTemplate
- No unit tests for Coordinator, WorkerBot, Analyst, simulation, or web server
- No integration/e2e tests

---

## 5. Gaps & Inconsistencies

### Docs vs Code
- **docs/PROJECT_DETAILS.md** mentions `recharge` in the graph; simulation has no recharge node
- Web UI (`terminal.html`) has handlers for `chaos_event` and `recharge`; neither node exists in the graph

### Unused / Placeholder
- `chaos_events` in graph-state and state.ts — never written; UI has `handleChaosEvent` for visuals only
- Onboarding wizard (`teamclaw onboard`) exists but is separate from Web UI flow; unclear if commonly used

### Configuration
- Session config: creativity, max_cycles, max_generations, worker_url, goal, team_template
- Env-only: CHROMADB_PERSIST_DIR, OPENCLAW_WORKERS (per-bot URLs)
- LLM model and base URL not exposed in Web UI

### Testing
- Vitest; no coverage thresholds
- No mocks for OpenClaw/ChromaDB in tests
- No end-to-end tests (Web or CLI)

---

## 6. Possible Idea Directions

1. **Testing**
   - Unit tests for Coordinator, WorkerBot, Analyst with mocked OpenClaw responses
   - Integration test for simulation (mock Sparki)
   - E2E for Web UI or CLI flow

2. **Graph & State**
   - Add recharge or chaos node if desired; otherwise remove dead UI handlers and state fields
   - Per-cycle or per-run goal variation
   - Human-in-the-loop / approval nodes

3. **Configuration**
   - Expose OpenClaw endpoint and auth settings in Web UI
   - Per-bot worker URLs table in UI
   - Validation and clearer error messages for misconfiguration

4. **UX**
   - Unified onboarding (merge Ink wizard with Web UI or make Web the primary)
   - Better error handling and user feedback in Web UI
   - Session history / replay

5. **RAG & Lessons**
   - Improve lesson quality (analyst prompts, retrieval)
   - Show lessons in Web UI
   - Configurable embedding model

6. **Production**
   - Health checks, metrics, graceful shutdown
   - Docker Compose for full stack (TeamClaw + ChromaDB + OpenClaw workers)
   - Release / versioning process

7. **Extensibility**
   - Custom team templates via config
   - Pluggable workers / adapters
   - Webhooks or events for external integration

---

## 7. Commands Reference

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run web          # http://localhost:8000
pnpm run work         # CLI work session
teamclaw work --runs 5
teamclaw check        # connectivity
teamclaw onboard      # Ink wizard
```

---

## 8. File Layout

```
teamclaw/
├── src/
│   ├── core/          state, config, simulation, knowledge-base, team-templates
│   ├── agents/        coordinator, worker-bot, analyst
│   ├── interfaces/    sparki-sdk (RealSparki, MockSparki)
│   ├── web/           server.ts, static/terminal.html
│   ├── onboard/       App.tsx, GoalStep, TeamTemplateStep, WorkerUrlStep
│   ├── cli.ts
│   ├── work-runner.ts
│   ├── check.ts
│   └── index.ts
├── tests/             state.test.ts (4 tests)
├── docs/               PROJECT_DETAILS.md, CURRENT_STATUS.md
├── .github/            workflows/ci.yml, ISSUE_TEMPLATE/, pull_request_template.md
├── package.json
├── pnpm-lock.yaml
├── teamclaw.config.example.json
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── CLAUDE.md          Repository guidelines for AI agents
```
