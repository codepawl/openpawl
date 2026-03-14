# TeamClaw

**AI agent team orchestration for complex goals.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

TeamClaw orchestrates teams of specialized AI agents through LangGraph. Define a goal, pick a team, and let the agents plan, execute, review, and learn from each run. A real-time web dashboard gives full visibility into every step.

---

## Features

- **Goal-driven orchestration** — describe what you want done; a Coordinator decomposes it into tasks and routes them to the right agents
- **9 specialized agents** — Coordinator, Worker Bot, Sprint Planner, Tech Lead, RFC Author, Post-Mortem Analyst, Retrospective, Memory Retrieval, and a Human Approval gate
- **Multi-run learning** — sequential runs store failures in vector memory (LanceDB); each subsequent run retrieves relevant lessons before planning
- **Human-in-the-loop** — configurable approval gates pause execution for review, edits, or feedback before proceeding
- **RFC-first policy** — high-complexity and architecture tasks require an RFC approval cycle before execution begins
- **Real-time dashboard** — Kanban board, Eisenhower matrix, live state graph, workflow stepper, cost tracking, and interactive approval modals over WebSocket
- **Per-agent model overrides** — set a global default LLM or assign specific models to individual agent roles
- **Zero-config work sessions** — run `teamclaw setup` once, then `teamclaw work` with no prompts or infrastructure flags

## Quickstart

**Prerequisites:** Node.js >= 20, pnpm, a running [OpenClaw](https://github.com/nxank4/openclaw) gateway.

```bash
# Install
pnpm install

# Interactive setup (connection, workspace, model, goal, team)
pnpm exec teamclaw setup

# Run a work session with the web dashboard
pnpm run work
```

The dashboard opens at `http://localhost:8000`. To run multiple learning iterations:

```bash
pnpm exec teamclaw work --runs 3
```

### Make targets

```
make install      # pnpm install
make check        # typecheck + test
make lint         # eslint
make web          # build & start dashboard
make work         # build & start work session
make clean        # remove dist, node_modules, vector stores
```

## CLI

| Command | Description |
|---------|-------------|
| `teamclaw setup` | Interactive 6-step wizard (connection, workspace, project, model, goal, team) |
| `teamclaw work` | Start a work session; `--runs N` for multi-run, `--no-web` to skip dashboard |
| `teamclaw config` | Interactive config dashboard; also supports `get`, `set`, `unset` subcommands |
| `teamclaw model` | Manage LLM selection: `list`, `get`, `set`, `set --agent <role> <model>`, `reset` |
| `teamclaw web` | Start/stop/status for the dashboard server |
| `teamclaw check` | Verify OpenClaw gateway connectivity |
| `teamclaw logs` | View gateway, web, or work session logs |
| `teamclaw demo` | Run a synthetic demo without a live gateway |
| `teamclaw lessons` | Export lessons learned from vector memory |

## Agent Architecture

Each agent is a LangGraph node that receives `GraphState` and returns only the keys it changed. The graph flows through five phases per sprint cycle:

```
Memory Retrieval -> Sprint Planning -> Task Decomposition -> Execution -> Retrospective
```

During execution, the Worker Bot follows a **Maker -> QA Reviewer -> Rework** loop. Tasks flagged as high-complexity enter an RFC approval cycle before work begins. The Human Approval node can pause any phase for manual review.

After each run, the Post-Mortem Analyst extracts lessons from failures and stores them in LanceDB. The next run's Memory Retrieval node queries these lessons to improve planning.

## Dashboard

The web UI connects over WebSocket and updates in real time:

- **Kanban Board** — task pipeline across Pending, Reviewing, Completed, and Rework columns
- **Eisenhower Matrix** — priority and impact visualization
- **Live State Graph** — LangGraph node execution flow
- **Workflow Stepper** — current sprint phase progress
- **Summary Cards** — tasks completed, failures, quality score, estimated cost
- **Console & Logs** — resizable terminal panel with agent output and OpenClaw gateway logs
- **Approval Modal** — approve, edit, or provide feedback on pending tasks
- **Settings** — model selection, color palettes, webhook configuration, log levels

Supports light, dark, and system theme modes.

## Documentation

| Document | Contents |
|----------|----------|
| [AGENTS.md](./docs/AGENTS.md) | Team culture, RFC policy, documentation standards |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design blueprint |
| [WEBHOOKS.md](./docs/WEBHOOKS.md) | Webhook event schemas and configuration |
| [OPENCLAW_PROVISIONING.md](./docs/OPENCLAW_PROVISIONING.md) | Gateway setup and provisioning |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Orchestration | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) |
| Web server | Fastify + WebSocket |
| Frontend | React, Tailwind CSS, Bootstrap Icons |
| Vector memory | LanceDB (embedded) |
| Validation | Zod |
| Build | tsup |
| Tests | Vitest |
| CLI prompts | @clack/prompts |

Pure TypeScript / Node.js. No Python dependencies.

## Security

To report a vulnerability, see [SECURITY.md](./SECURITY.md). Do not open public issues for security reports.

Key points for deployers:

- The dashboard server has **no built-in authentication**. Bind it to `127.0.0.1` or a trusted network.
- Configuration lives in `~/.teamclaw/config.json` and may contain API tokens. Protect it with restrictive file permissions.
- Agent output should be treated as untrusted. Review generated artifacts before applying to production systems.

## License

[MIT](./LICENSE)
