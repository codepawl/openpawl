# Contributing to OpenPawl

Thanks for your interest in contributing.

## Setup

```bash
git clone https://github.com/nxank4/openpawl.git
cd openpawl
bun install
bun run build
```

## Development

```bash
bun run dev          # watch mode
bun run test         # run tests
bun run typecheck    # type check
bun run lint         # lint
make check            # typecheck + test
make test-full        # typecheck + lint + test + build
```

## Code Style

- TypeScript (ESM, strict). No `any`, no `@ts-nocheck`.
- Keep files under ~700 LOC.
- Brief comments for non-obvious logic only.
- Vitest for tests. Run `bun run test` before pushing.

## Pull Requests

- Concise action-oriented commit messages (e.g. `fix: add reducer to graph-state`).
- Group related changes; don't bundle unrelated refactors.
- All CI checks must pass (typecheck, lint, test, build).

## Architecture

See [CLAUDE.md](./CLAUDE.md) for the full architecture guide.

## Reporting Issues

Use [GitHub Issues](https://github.com/nxank4/openpawl/issues).

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.
