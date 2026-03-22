# Changelog

## [0.0.1] - 2026-03-18

### Added
- Multi-provider LLM support: Anthropic, OpenAI, OpenRouter, Ollama, DeepSeek, Groq, and custom endpoints
- Provider fallback chain with automatic failover
- Setup wizard with 7 provider options and API key configuration
- `teamclaw check` validates provider health with latency reporting
- `teamclaw providers list|test` for provider chain management
- Provider-prefixed model names (`anthropic/claude-sonnet-4-6`, `deepseek/deepseek-chat`)
- Response caching with per-provider cache keys
- Health monitor with periodic provider checks
- Template marketplace: browse, install, publish, and update community templates
- `teamclaw work --template <id>` for template-based team composition
- Five seed templates: content-creator, indie-hacker, research-intelligence, business-ops, full-stack-sprint

### Core
- 12-node LangGraph orchestration pipeline with parallel worker execution
- Confidence-gated task approval (auto-approve, QA loop, escalate)
- Vector memory via embedded LanceDB for success patterns and failure lessons
- Decision journal with supersession detection
- Sprint retrospective with rework detection
- Global memory promotion engine
- Session briefing ("previously on TeamClaw")
- CONTEXT.md handoff generation

### Solo Developer Tools
- `teamclaw think` rubber duck mode with multi-round deliberation
- `teamclaw standup` daily summary with streak tracking
- `teamclaw clarity` goal analysis and rewriting
- `teamclaw drift` goal-vs-decision conflict detection
- `teamclaw score` vibe coding score and trends
- `teamclaw forecast` cost estimation before runs
- `teamclaw heatmap` agent utilization analysis
- `teamclaw replay` session replay for debugging
- `teamclaw audit` full decision trail export
- `teamclaw diff` cross-run comparison

### Observability
- Real-time WebSocket dashboard with Kanban, Eisenhower matrix, live graph
- SSE proxy for browser-based LLM log streaming
- Agent personality system with pushback detection
- Webhook approval for unattended runs (Slack/generic)
- Cost tracking and per-run forecasting
