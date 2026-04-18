#!/usr/bin/env bash
set -euo pipefail

GOAL="Build a CLI task manager: add/list/complete/delete tasks, priority levels, due dates, filter by status/priority, JSON file persistence, colored output. TypeScript, only chalk as external dep."
WORKDIR="$HOME/personal/openpawl-test-projects/bench/cli-task-manager-sprint-context-fix"
PARENT_LOG="benchmarks/debug-reruns/2026-04-17/parent-cli-sprint-run8-context-fix.jsonl"
TARGET_LOG="benchmarks/debug-reruns/2026-04-17/cli-task-manager-sprint-post-context-fix.jsonl"
TIMEOUT_MS=1200000  # 20 minutes

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
mkdir -p "$(dirname "$PARENT_LOG")"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
SHA=$(git rev-parse --short HEAD)

printf '{"event":"run:start","timestamp":"%s","task":"cli-task-manager","mode":"sprint","branch":"%s@%s","workdir":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BRANCH" "$SHA" "$WORKDIR" > "$PARENT_LOG"

START=$(date +%s)

# Pre-run: snapshot existing debug logs so we can find the new one
BEFORE=$(ls -1 "$HOME/.openpawl/debug/" 2>/dev/null | sort -u || true)

set +e
OPENPAWL_DEBUG=true OPENPAWL_PROFILE=true \
  timeout --signal=TERM --kill-after=10 $((TIMEOUT_MS / 1000)) \
  "$HOME/.bun/bin/bun" dist/cli.js run --headless \
    --goal "$GOAL" \
    --mode sprint \
    --workdir "$WORKDIR" \
  > /tmp/context-fix-bench.stdout 2> /tmp/context-fix-bench.stderr
EXIT=$?
set -e

END=$(date +%s)
DURATION_MS=$(( (END - START) * 1000 ))

printf '{"event":"run:close","timestamp":"%s","exitCode":%d,"durationMs":%d}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXIT" "$DURATION_MS" >> "$PARENT_LOG"

# Find the new debug log file
AFTER=$(ls -1 "$HOME/.openpawl/debug/" 2>/dev/null | sort -u || true)
NEW_FILES=$(comm -13 <(echo "$BEFORE") <(echo "$AFTER") | head -5)

# Prefer a sprint-tagged file with events matching our run
BEST=""
for f in $NEW_FILES; do
  FP="$HOME/.openpawl/debug/$f"
  if head -n 5 "$FP" | grep -q 'sprint\|cli-task-manager-sprint-context-fix' ; then
    BEST="$FP"
    break
  fi
done
# Fallback: just the most recent
if [ -z "$BEST" ]; then
  BEST=$(ls -t "$HOME/.openpawl/debug/"*.jsonl 2>/dev/null | head -n 1 || true)
fi

if [ -n "$BEST" ] && [ -f "$BEST" ]; then
  cp "$BEST" "$TARGET_LOG"
  echo "[ok] copied $BEST → $TARGET_LOG"
fi

echo "exit=$EXIT duration_ms=$DURATION_MS"
echo "last 20 lines stderr:"
tail -20 /tmp/context-fix-bench.stderr 2>/dev/null || true
