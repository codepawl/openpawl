#!/usr/bin/env bash
# Run bun tests directory-by-directory.
# Each batch runs in a separate bun process to prevent mock.module leaks.
set -uo pipefail

COVERAGE_FLAG=""
if [[ "${1:-}" == "--coverage" ]]; then
  COVERAGE_FLAG="--coverage"
  shift
fi

# If specific paths given, run those directly
if [[ $# -gt 0 ]]; then
  exec bun test $COVERAGE_FLAG "$@"
fi

TOTAL_PASS=0
TOTAL_FAIL=0
BATCHES=0

run_batch() {
  local output
  output=$(bun test $COVERAGE_FLAG --timeout=10000 "$@" 2>&1)
  local rc=$?
  echo "$output"

  local pass=$(echo "$output" | grep -oP '^\s*\K\d+(?= pass)' | tail -1)
  local fail=$(echo "$output" | grep -oP '^\s*\K\d+(?= fail)' | tail -1)
  TOTAL_PASS=$((TOTAL_PASS + ${pass:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${fail:-0}))
  BATCHES=$((BATCHES + 1))
  return $rc
}

# Root-level test files
for f in tests/*.test.ts; do
  [ -f "$f" ] && run_batch "$f"
done

# Co-located src tests
if compgen -G "src/**/*.test.ts" > /dev/null 2>&1; then
  run_batch src/
fi

# Test subdirectories
for dir in tests/*/; do
  count=$(find "$dir" -name "*.test.ts" -maxdepth 2 2>/dev/null | wc -l)
  if [[ "$count" -gt 0 ]]; then
    run_batch "$dir"
  fi
done

echo ""
echo "=== Summary: $TOTAL_PASS passed, $TOTAL_FAIL failed across $BATCHES batches ==="
if [[ $TOTAL_FAIL -gt 0 ]]; then
  exit 1
fi
