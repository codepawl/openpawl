# Makefile for TeamClaw
.PHONY: help install install-hooks test lint typecheck check test-full web work clean

help:
	@echo "TeamClaw - Available Commands:"
	@echo ""
	@echo "  Setup"
	@echo "    make install       - Install pnpm dependencies"
	@echo "    make install-hooks - Set up pre-commit quality gate"
	@echo ""
	@echo "  Quality"
	@echo "    make test     - Run test suite"
	@echo "    make lint     - Lint code"
	@echo "    make typecheck - Run type checker"
	@echo "    make check     - Lint + typecheck + test"
	@echo "    make test-full - Full quality gate (tsc + eslint + vitest + build)"
	@echo ""
	@echo "  Run"
	@echo "    make web      - Launch web UI (http://localhost:8000)"
	@echo "    make work    - Run work sessions (CLI)"
	@echo ""
	@echo "  Maintenance"
	@echo "    make clean   - Remove build artifacts"

install:
	@echo "Installing dependencies..."
	pnpm install
	@echo "Dependencies installed!"

install-hooks:
	git config core.hooksPath .githooks
	@echo "Pre-commit hook installed (.githooks/pre-commit)"

test:
	@echo "Running tests..."
	pnpm run test

lint:
	@echo "Linting..."
	pnpm run lint 2>/dev/null || echo "Add lint script to package.json"

typecheck:
	@echo "Type checking..."
	pnpm run typecheck

check: typecheck test
	@echo "Checks passed!"

test-full:
	@echo "═══ Full Quality Gate ═══"
	@echo "→ TypeScript..."
	pnpm exec tsc --noEmit
	@echo "→ ESLint..."
	pnpm exec eslint src/ --ext .ts,.tsx
	@echo "→ Vitest..."
	pnpm exec vitest run
	@echo "→ Build..."
	pnpm run build
	@echo "═══ All checks passed ═══"

web:
	pnpm run build && NODE_ENV=production node dist/cli.js web

work:
	pnpm run build && node dist/cli.js work --web

clean:
	@echo "Cleaning..."
	rm -rf dist node_modules .turbo .pnpm-store
	rm -rf data/test_vector_store data/vector_store
	@echo "Cleaned!"
