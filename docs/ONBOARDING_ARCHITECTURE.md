# Onboarding Wizard Architecture (OpenClaw-Only)

## Overview

The onboarding flow is state-machine based and focused on a lightweight OpenClaw setup.

TeamClaw onboarding now collects only:
1. OpenClaw Gateway URL
2. OpenClaw Token
3. Dynamic team roster
4. Default goal

## State Machine Flow

```text
WORKER_URL -> AUTH_TOKEN -> TEAM_SIZE -> TEAM_BUILDER -> GOAL -> SUMMARY -> FINISH
```

Back navigation is supported using a history stack and `← Back` options on `select` prompts.

## Persisted Outputs

### `.env`
- `OPENCLAW_WORKER_URL`
- `OPENCLAW_TOKEN`

### `teamclaw.config.json`
- `roster` (dynamic array: role/count/description)
- `goal`

## Notes

- Legacy gateway/API-key prompts are removed from onboarding.
- TeamClaw runtime expects OpenClaw to be reachable and fails fast otherwise.
