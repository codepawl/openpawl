# Makefile for TeamClaw
.PHONY: help install install-hooks test test-commands test-coverage test-coverage-report lint typecheck check test-full web work clean release

help:
	@echo "TeamClaw - Available Commands:"
	@echo ""
	@echo "  Setup"
	@echo "    make install       - Install pnpm dependencies"
	@echo "    make install-hooks - Set up pre-commit quality gate"
	@echo ""
	@echo "  Quality"
	@echo "    make test          - Run test suite"
	@echo "    make test-commands       - Run CLI command tests only"
	@echo "    make test-coverage       - Run tests with coverage thresholds"
	@echo "    make test-coverage-report - Run tests + open HTML report"
	@echo "    make lint     - Lint code"
	@echo "    make typecheck - Run type checker"
	@echo "    make check     - Lint + typecheck + test"
	@echo "    make test-full - Full quality gate (tsc + eslint + vitest + build)"
	@echo ""
	@echo "  Run"
	@echo "    make web      - Launch web UI (http://localhost:8000)"
	@echo "    make work    - Run work sessions (CLI)"
	@echo ""
	@echo "  Release"
	@echo "    make release   - Build, package, and create GitHub release"
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

test-commands:
	@echo "Running command integration tests..."
	pnpm exec vitest run --config vitest.config.commands.ts

test-coverage:
	@echo "Running tests with coverage..."
	pnpm run test:coverage

test-coverage-report:
	@echo "Running tests with coverage (HTML report)..."
	pnpm exec vitest run --coverage --coverage.reporter=html
	@echo "Open coverage/index.html in your browser"
	open coverage/index.html 2>/dev/null || xdg-open coverage/index.html 2>/dev/null || true

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

# --- Release ---
VERSION := $(shell node -p "require('./package.json').version")

release:
	@echo "Building TeamClaw v$(VERSION)..."
	pnpm run build
	@echo ""
	@echo "Creating release archives..."
	@mkdir -p release
	@# Package source-install tarball (includes built dist/)
	tar -czf "release/teamclaw-$(VERSION)-source.tar.gz" \
		--exclude=node_modules --exclude=.git --exclude=release \
		--exclude=coverage --exclude=data --exclude=.teamclaw \
		-C . .
	@echo "Created release/teamclaw-$(VERSION)-source.tar.gz"
	@# Generate checksums
	@cd release && shasum -a 256 *.tar.gz > SHA256SUMS
	@echo "Generated release/SHA256SUMS"
	@echo ""
	@echo "Creating GitHub release v$(VERSION)..."
	gh release create "v$(VERSION)" \
		--title "TeamClaw v$(VERSION)" \
		--generate-notes \
		release/teamclaw-$(VERSION)-source.tar.gz \
		release/SHA256SUMS
	@echo ""
	@echo "Release v$(VERSION) published!"
	@echo "https://github.com/nxank4/teamclaw/releases/tag/v$(VERSION)"
