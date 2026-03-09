# OpenClaw Provisioning API

TeamClaw calls OpenClaw at session start to provision the workspace. OpenClaw (as a separate project) must implement this endpoint; TeamClaw acts as the client.

## Endpoint

**POST** `{OPENCLAW_WORKER_URL}/provision`

## Request

- **Headers:** `Content-Type: application/json`
- **Body (JSON):**

| Field             | Type   | Description                    |
|------------------|--------|--------------------------------|
| `project_context` | string | Optional project/session context |
| `role`           | string | Optional role identifier       |
| `params`         | object | Optional key-value parameters  |
| `llm`            | object | Optional. When TeamClaw uses the AI gateway, it sends this so OpenClaw needs no LLM config. |

**`llm` object** (when present):

| Field         | Type   | Description |
|---------------|--------|-------------|
| `gateway_url` | string | OpenAI-compatible base URL (e.g. `http://localhost:4000/v1`). OpenClaw should call `POST {gateway_url}/chat/completions` with the given `model`. |
| `model`       | string | Model name (as configured in your OpenClaw gateway). |

Example (without gateway):

```json
{
  "project_context": "Build a 2D game",
  "role": "game_dev",
  "params": { "max_cycles": 10 }
}
```

Example (with gateway; TeamClaw adds `llm` when `GATEWAY_URL` is set):

```json
{
  "project_context": "Build a 2D game",
  "role": "game_dev",
  "params": { "max_cycles": 10 },
  "llm": {
    "gateway_url": "http://localhost:4000/v1",
    "model": "team-default"
  }
}
```

## Response

- **200 OK** — Provisioning succeeded. Body is not required.
- **4xx / 5xx** — Failure. TeamClaw treats this as provisioning failed and continues in light-only mode (CLI/Web) or surfaces `provision_error` to the UI.

## Timeout

TeamClaw uses `OPENCLAW_PROVISION_TIMEOUT` (default 30 seconds). If the request times out, provisioning is considered failed.

## When TeamClaw Calls

- **CLI** (`teamclaw work`): Before the first run when `OPENCLAW_WORKER_URL` (or per-bot worker URL) is set. Retries once after 2 seconds on failure.
- **Web UI**: When the user starts a session and a worker URL is configured. On failure, the server sends a `provision_error` event over the WebSocket so the UI can show "OpenClaw unavailable – running in light-only mode".

## OpenClaw in Docker

Containers that run browser/desktop automation often need extra configuration:

- **Shared memory:** e.g. `shm_size: '2g'` for Chrome/Chromium.
- **VNC (optional):** Expose a port (e.g. `6080:6080`) to attach a VNC client and watch the bot’s virtual display for debugging.

See `docker-compose.yml` comments for the OpenClaw service and uncomment or add these options as needed.
