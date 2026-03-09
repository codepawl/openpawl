# TeamClaw — Project Details

> **Last Updated:** 2026-03
> **Version:** 0.1.0
> **Runtime:** Node.js >= 20
> **Package Manager:** pnpm

---

## 1. Project Overview

**TeamClaw** is an OpenClaw-powered team orchestration application. Users define goals and teams (e.g. Game Dev: programmers, artist, SFX), and **Sparki (OpenClaw)** agents collaborate to produce real outputs. **LangGraph** orchestrates the workflow.

### Core Concept

- User chooses a **team template** (Game Dev, Startup, Content) and sets a **goal**
- The **Coordinator** decomposes the goal into subtasks and assigns by role
- **WorkerBots** execute tasks via OpenClaw
- Single run by default; optional multi-run mode learns from failed runs
- Lessons persist via **ChromaDB** (or JSON fallback) for RAG

---

## 2. Repository Structure

```
teamclaw/
├── src/
│   ├── core/           # State, config, orchestration, knowledge-base
│   ├── agents/         # Coordinator, WorkerBot, Analyst
│   ├── interfaces/     # Sparki SDK (RealSparki/MockSparki)
│   ├── web/            # Fastify server + static terminal.html
│   ├── cli.ts          # CLI entry (work, web)
│   ├── work-runner.ts  # Work session logic
│   └── index.ts        # Package exports
├── tests/              # Vitest tests
├── docs/               # Documentation
├── data/               # ChromaDB persistence, vector_store
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── .env.example
├── CLAUDE.md
└── README.md
```

---

## 3. Architecture

### LangGraph Graph Flow

Orchestration uses `StateGraph` in `src/core/simulation.ts`:

```
coordinator → [has_pending] → worker_execute → recharge → increment_cycle →
     ↑             ↓                    [continue] ←─────────────────────┘
   [loop]        [end]
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `src/core/state.ts` | Zod schemas, `GameState`, `initializeGameState`, `initializeTeamState` |
| `src/core/graph-state.ts` | LangGraph `Annotation` for state shape |
| `src/core/simulation.ts` | `TeamOrchestration` class, `createTeamOrchestration` |
| `src/core/config.ts` | `CONFIG` from `.env` |
| `src/core/knowledge-base.ts` | `VectorMemory` (ChromaDB / JSON fallback) |
| `src/core/bot-definitions.ts` | Role templates, `BotDefinition` |
| `src/core/team-templates.ts` | Presets: game_dev, startup, content |
| `src/agents/coordinator.ts` | Goal decomposition via OpenClaw |
| `src/agents/worker-bot.ts` | Task execution via Sparki SDK |
| `src/agents/analyst.ts` | PostMortemAnalyst for failure analysis |
| `src/interfaces/sparki-sdk.ts` | OpenClaw-backed worker SDK integration |
| `src/web/server.ts` | Fastify + WebSocket, streams workflow events |
| `src/work-runner.ts` | CLI work sessions with lesson learning |

---

## 4. State Management

`GameState` (in `src/core/state.ts`) is the central state passed between LangGraph nodes. Key fields include:

| Field | Purpose |
|-------|---------|
| `session_active` | Whether work session is active |
| `task_queue` | Pending/completed tasks |
| `team` | Bot definitions |
| `bot_stats` | Per-bot task counts, energy |
| `user_goal` | User-defined goal |
| `ancestral_lessons` | Lessons from prior runs (RAG) |

---

## 5. Entry Points

| Command | Description |
|---------|-------------|
| `teamclaw web` | Fastify + WebSocket UI at http://localhost:8000 |
| `teamclaw work` | CLI work sessions (single or multi-run with `--runs N`) |

---

## 6. Configuration

### First-time Setup (UI-first)

1. **Web UI**: Run `pnpm run web`; set **OpenClaw Worker URL** in the splash before starting.
2. **Config file**: Copy `teamclaw.config.example.json` to `teamclaw.config.json`; set `workers`, `goal`, `creativity` (0–1).
3. **.env** (advanced): Copy `.env.example` to `.env` for env-only overrides.

### Session overrides (Web UI / teamclaw.config.json)

| Option | Description |
|--------|-------------|
| `creativity` | 0–1, maps to LLM temperature |
| `max_cycles` | Work session cycle limit |
| `max_generations` | Max retries with lesson learning |
| `worker_url` | OpenClaw worker URL (Web UI) |
| `goal` | Session goal |
| `team_template` | game_dev, startup, content |

### Env-only (`.env`)

- `CREATIVITY` — LLM default tuning
- `MAX_CYCLES`, `MAX_RUNS` — Session limits
- `CHROMADB_PERSIST_DIR` — Vector store path
- `OPENCLAW_WORKER_URL`, `OPENCLAW_WORKERS` — Fallback worker URLs

---

## 7. Tech Stack

LangGraph.js, Zod, Fastify, WebSocket, ChromaDB (optional), OpenClaw. TypeScript only.
