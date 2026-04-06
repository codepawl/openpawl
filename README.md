# OpenPawl

**Your AI team for vibe coding. Stop prompting alone.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

OpenPawl orchestrates a team of specialized AI agents toward your goals — with memory, learning, and structure that persists across sessions.

---

## The Problem

Vibe coding alone is a grind. Every session starts from scratch:

```
Before OpenPawl:                    After OpenPawl:
───────────────────────────────     ──────────────────────────────
Prompt into the void            →   Persistent team memory
Re-explain context every time   →   Instant session briefing
Make decisions alone            →   Structured debate + review
Forget why you chose X          →   Decision journal
Repeat the same mistakes        →   Global lessons learned
Ship things you're unsure of    →   Confidence-gated delivery
No structure                    →   Sprint cadence with standup
```

OpenPawl replaces that friction with a team that remembers, learns, and holds itself accountable.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/nxank4/openpawl/main/install.sh | sh
```

Or via npm:

```bash
npm install -g @openpawl/cli
```

**Requirements:** Node.js >= 20, bun, and an LLM API key (Anthropic, OpenAI, OpenRouter, DeepSeek, Groq, or local Ollama).

---

## Quickstart

```bash
openpawl setup                    # 6-step guided wizard
openpawl work --goal "Build auth" # start a sprint
openpawl standup                  # daily summary
openpawl think "SSE or WebSocket?" # rubber duck mode
```

The dashboard opens automatically at `http://localhost:8000`.

---

## Features

### Team Orchestration

9 specialized agents collaborate through a LangGraph pipeline: Coordinator, Worker Bot, Sprint Planner, Tech Lead, RFC Author, Post-Mortem Analyst, Retrospective, Memory Retrieval, and Human Approval. Independent tasks execute in parallel via the LangGraph Send API. Agents self-report confidence — uncertain work auto-routes to QA or rework. Good tasks get approved individually while bad ones go back.

Team composition is flexible: pick agents manually, let the system compose autonomously based on your goal, or use a pre-built template. You can build custom agents via `@openpawl/sdk` and plug them in.

### Memory and Learning

The team remembers everything across sessions. Success patterns get stored in LanceDB — future runs retrieve what worked. Failures feed a post-mortem loop so mistakes don't repeat. Every architectural decision is logged in a searchable decision journal. Global patterns persist across all sessions forever.

### Solo Developer Tools

- **Session briefing** — "previously on OpenPawl" context every time you start
- **Daily standup** — what was done, what's blocked, what's next
- **Rubber duck mode** — structured debate from two perspectives without starting a sprint
- **Drift detection** — flags when a new goal contradicts past decisions
- **Goal clarity checker** — challenges vague goals before planning begins
- **Context handoff** — auto-generates CONTEXT.md at session end
- **Vibe coding score** — mirror showing how you collaborate with your team
- **Async thinking** — submit a question before sleep, wake up to analysis

### Observability and Control

- **Real-time dashboard** — Kanban, Eisenhower matrix, live graph, cost tracking
- **Audit trail** — full decision log exported as markdown
- **Replay mode** — re-run any past session for debugging
- **Agent heatmap** — find utilization bottlenecks across runs
- **Cost forecasting** — estimate cost before a run starts
- **Webhook approval** — Slack/email approval for unattended runs

---

## Template Marketplace

Pre-built teams you can install and use immediately:

```bash
openpawl templates browse
openpawl templates install indie-hacker
openpawl work --template indie-hacker --goal "Build auth system"
```

| Template | Pipeline |
|----------|----------|
| `content-creator` | Research, Script, SEO, Review |
| `indie-hacker` | Architect, Engineer, QA, RFC |
| `research-intelligence` | Research, Verify, Synthesize |
| `business-ops` | Process, Automate, Document |
| `full-stack-sprint` | Frontend, Backend, DevOps, Lead |

Five seed templates ship offline. Community templates at [openpawl-templates](https://github.com/nxank4/openpawl-templates).

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `setup` | Guided setup wizard |
| `work` | Start a work session (`--runs N`, `--template <id>`) |
| `standup` | Daily standup summary |
| `think` | Rubber duck mode — structured debate |
| `config` | Manage configuration |
| `model` | LLM selection: list, set, per-agent overrides |
| `web` | Start/stop dashboard server |
| `templates` | Browse, install, publish marketplace templates |
| `journal` | Decision journal: list, search, show, export |
| `score` | Vibe coding score and trends |
| `replay` | Replay past sessions for debugging |
| `audit` | Export audit trail |
| `forecast` | Estimate run cost before execution |
| `heatmap` | Agent utilization heatmap |
| `diff` | Compare runs within or across sessions |
| `memory` | Global memory: health, prune, export/import |
| `profile` | Agent performance profiles |
| `agent` | Manage custom agents |
| `clarity` | Check goal clarity |
| `drift` | Detect goal vs decision conflicts |
| `handoff` | Generate or import CONTEXT.md |
| `lessons` | Export lessons learned |
| `logs` | View session and gateway logs |
| `clean` | Remove session data (preserves memory) |
| `update` | Self-update to latest version |

---

## Agent Architecture

```
Memory Retrieval ─► Sprint Planning ─► System Design ─► RFC Phase
                                                           │
                                                    Coordinator
                                                     ┌────┼────┐
                                                     ▼    ▼    ▼
                                                   Worker Worker Worker
                                                     └────┼────┘
                                                          ▼
                                                  Confidence Router
                                                   ┌──────┼──────┐
                                                   ▼      ▼      ▼
                                                 Auto   QA Loop  Escalate
                                                Approve    │
                                                   └──────┼──────┘
                                                          ▼
                                                  Partial Approval
                                                          │
                                                          ▼
                                              Post-Mortem ─► Memory Store
```

12-node LangGraph pipeline. Workers execute in parallel via Send API. The confidence router auto-approves high-confidence work, loops uncertain tasks through QA, and escalates failures. Post-mortem extracts lessons into vector memory for future runs.

---

## Dashboard

Real-time WebSocket dashboard at `localhost:8000`:

- Kanban board with task pipeline
- Eisenhower priority matrix
- Live LangGraph node execution view
- Summary cards: tasks, cost, confidence
- Memory, replay, journal, heatmap, and score tabs
- Interactive approval modal for human-in-the-loop
- Light, dark, and system themes

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Orchestration | LangGraph.js |
| Web server | Fastify + WebSocket |
| Frontend | React, Tailwind CSS |
| Vector memory | LanceDB (embedded) |
| Validation | Zod |
| Build | tsup |
| Tests | Vitest |
| CLI prompts | @clack/prompts |

Pure TypeScript / Node.js. No Python.

---

## Docker

### Quick start

```bash
cp .env.example .env
# Add your API key to .env

docker compose up -d
open http://localhost:8000
```

### Run a work session

```bash
# Interactive (with dashboard)
docker compose up -d
docker compose exec openpawl node dist/cli.js work --goal "your goal"

# Headless
docker compose run --rm openpawl \
  node dist/cli.js work --goal "Build a rate limiter" --no-web

# With a template
docker compose run --rm openpawl \
  node dist/cli.js work --template indie-hacker --goal "Build auth system" --no-web
```

### Persistent data

All data (memory, sessions, decisions, patterns) is stored in the `openpawl-data` Docker volume.

```bash
# Backup
docker run --rm -v openpawl_openpawl-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/openpawl-backup.tar.gz /data

# Restore
docker run --rm -v openpawl_openpawl-data:/data -v $(pwd):/backup \
  alpine tar xzf /backup/openpawl-backup.tar.gz -C /
```

### Development mode

```bash
# Uses docker-compose.override.yml automatically (mock LLM, no API calls)
docker compose up
```

---

## Security

- Dashboard has **no built-in auth** — bind to `127.0.0.1`
- Config at `~/.openpawl/config.json` may contain API tokens
- Agent output is untrusted — review before applying to production
- Global memory at `~/.openpawl/memory/global.db` — back it up

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

---

## Documentation

| Document | Contents |
|----------|----------|
| [AGENTS.md](./docs/AGENTS.md) | Team culture and RFC policy |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design |
| [CUSTOM_AGENTS.md](./docs/CUSTOM_AGENTS.md) | Custom agent SDK guide |
| [WEBHOOKS.md](./docs/WEBHOOKS.md) | Webhook event schemas |
| [PROVIDERS.md](./docs/PROVIDERS.md) | LLM provider setup |

---

## License

[MIT](./LICENSE)
