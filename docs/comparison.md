# OpenPawl Feature Comparison

Detailed comparison of OpenPawl against other AI coding tools.

## Quick Summary

| Feature | OpenPawl | Claude Code | OpenCode | Aider |
|---------|----------|-------------|----------|-------|
| Multi-agent orchestration | 3 modes (solo/collab/sprint) | Single agent | Single agent | Single agent |
| Cross-session memory | LanceDB vector + hebbian | Per-project CLAUDE.md | None | Git-based |
| Post-mortem learning | Extracts & injects lessons | None | None | None |
| Team templates | 5 built-in + custom | None | None | None |
| Inline file diffs | Colored unified diffs | Built-in | None | Git diff |
| Decision journal | Searchable, drift detection | None | None | None |
| Cost forecasting | 3 methods + learning curves | None | None | None |
| Interactive TUI | Custom (Catppuccin, mouse) | Built-in | Bubbletea | Terminal |
| Headless mode | `--mode`, `--template`, `--runs` | Non-interactive | CLI only | CLI only |
| Agent heatmap | Utilization + bottleneck | None | None | None |
| Session briefing | Auto-context from prior runs | None | None | None |
| Drift detection | Flags goal/decision conflicts | None | None | None |
| Replay mode | Re-run past sessions | None | None | None |
| Vibe coding score | 4-dimension collaboration score | None | None | None |
| Context compression | Auto-compaction < 1x growth | Built-in | None | None |
| @file references | Attach files to prompts | Built-in | None | /add command |
| !command execution | Shell from TUI | Built-in | None | /run command |

## Where Others Excel

- **Claude Code**: More mature single-agent experience, deeper IDE integration, larger community
- **Aider**: Better git integration, wider model support, more battle-tested for solo coding
- **OpenCode**: Simpler setup, lighter footprint

## Where OpenPawl Excels

- Multi-agent workflows with team composition
- Persistent learning across sessions (hebbian memory + post-mortem)
- Sprint mode with parallel task execution
- Team templates for repeatable workflows
- Cost forecasting and agent heatmaps
