# TeamClaw: OpenClaw Team Orchestration

TeamClaw is an orchestration layer for OpenClaw teams. It decomposes goals, coordinates worker bots, and tracks lessons learned via vector memory.

TeamClaw now uses an OpenClaw-first architecture:
- All LLM traffic goes through OpenClaw.
- TeamClaw keeps LLM routing minimal and externalized.

## Quick Start

```bash
# 1) Install globally (Node >= 22)
npm install -g teamclaw@latest

# 2) Run onboarding
teamclaw onboard

# 3) Start a session
teamclaw work --goal "Build a landing page"
```

## Required Configuration

Set these values in `.env` (or via onboarding):

- `OPENCLAW_WORKER_URL` (example: `http://localhost:8001`)
- `OPENCLAW_TOKEN`

## Commands

- `teamclaw onboard` — guided setup (OpenClaw URL, token, roster, goal)
- `teamclaw work` — run orchestration session
- `teamclaw web` — start dashboard at `http://localhost:8000`
- `teamclaw check` — connectivity check for OpenClaw
- `teamclaw start|stop|status` — background web service management

## Docker

```bash
docker compose up                      # web + chromadb
docker compose --profile openclaw up  # add OpenClaw worker
```

When using the OpenClaw Docker profile, set:
- `OPENCLAW_WORKER_URL=http://openclaw:3000`
- `OPENCLAW_TOKEN=<token>`

## License

MIT
