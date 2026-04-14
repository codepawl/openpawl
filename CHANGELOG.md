# Changelog

## [0.1.0] - 2026-04-14

First public release. Major rewrite from v0.0.1: replaced LangGraph pipeline with native API tool calling, added TUI-first interactive mode, removed dead code (11k LOC), and added 15 new features.

### Added
- 3 execution modes: solo, collab, sprint (replaces single LangGraph pipeline)
- Interactive TUI with Catppuccin Mocha theme, mouse support, keyboard navigation
- `/agents` CRUD — create, edit, delete custom agents from TUI
- `/team` view — browse and switch team templates interactively
- `/mode` — switch between solo, collab, sprint with Shift+Tab
- Inline colored diffs on file writes/edits (TUI and headless)
- Escape to cancel any streaming response
- Headless mode: `openpawl run --headless --goal "..." --mode --template --runs --workdir`
- Context compression — automatic compaction keeps context growth < 1x
- Token counter in status bar (live input/output tracking)
- Type-to-filter in all list views (agents, templates, sessions)
- Centralized keybindings with `/hotkeys`
- Post-mortem learning — extracts lessons across runs, injects into future planning
- Hebbian memory — strengthens concept associations based on co-activation
- Autonomous team composition based on goal analysis
- Performance profiler (opt-in timing breakdown)
- Min terminal size handling with graceful degradation
- Provider/model sync as single source of truth

### Changed
- LLM engine: native API tool calling with multi-turn streaming (replaces LangGraph)
- Architecture: prompt router → agent runner → LLM multi-turn loop
- Test runner: Bun test (was Vitest)
- Sprint mode: keyword-based agent assignment (was coordinator-based)

### Removed
- LangGraph dependency and 12-node pipeline
- Standalone dashboard server (Fastify + SSE)
- 153 dead code files (11k LOC): plugins, MCP server, streaming, old setup wizard
- Instructor.js structured output layer
- Langfuse telemetry integration

## [0.0.1] - 2026-03-18

### Added
- Multi-provider LLM support: Anthropic, OpenAI, OpenRouter, Ollama, DeepSeek, Groq
- Provider fallback chain with automatic failover
- Setup wizard with provider configuration
- Template marketplace: browse, install, publish
- 5 seed templates: content-creator, indie-hacker, research-intelligence, business-ops, full-stack-sprint
- 12-node LangGraph orchestration pipeline with parallel worker execution
- Vector memory via embedded LanceDB
- Decision journal, drift detection, standup, replay, heatmap, forecast
- Rubber duck mode, vibe coding score, cost forecasting
- Real-time WebSocket dashboard
