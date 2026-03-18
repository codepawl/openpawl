# Contributing to TeamClaw

Thanks for your interest in contributing.

## Setup

```bash
git clone https://github.com/nxank4/teamclaw.git
cd teamclaw
pnpm install
pnpm run build
```

## Development

```bash
pnpm run dev          # watch mode
pnpm run test         # run tests
pnpm run typecheck    # type check
pnpm run lint         # lint
make check            # typecheck + test
make test-full        # typecheck + lint + test + build
```

## Code Style

- TypeScript (ESM, strict). No `any`, no `@ts-nocheck`.
- Keep files under ~700 LOC.
- Brief comments for non-obvious logic only.
- Vitest for tests. Run `pnpm run test` before pushing.

## Pull Requests

- Concise action-oriented commit messages (e.g. `fix: add reducer to graph-state`).
- Group related changes; don't bundle unrelated refactors.
- All CI checks must pass (typecheck, lint, test, build).

## Architecture

See [CLAUDE.md](./CLAUDE.md) for the full architecture guide.

## Reporting Issues

Use [GitHub Issues](https://github.com/nxank4/teamclaw/issues).

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.
