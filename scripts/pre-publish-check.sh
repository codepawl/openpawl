#!/bin/bash
set -e

echo "OpenPawl Pre-Publish Checklist"
echo "═══════════════════════════════"

# 1. Build
echo "Building..."
bun run build
echo "✓ Build succeeded"

# 2. Type check
echo "Type checking..."
bun run typecheck
echo "✓ Types clean"

# 3. Lint
echo "Linting..."
bun run lint
echo "✓ Lint clean"

# 4. Tests
echo "Running tests..."
bun run test
echo "✓ All tests pass"

# 5. No hardcoded secrets
echo "Checking for secrets..."
if grep -rn "sk-ant-api\|sk-proj-\|gsk_[A-Za-z]" src/ --include="*.ts" -l 2>/dev/null; then
  echo "✗ Possible secrets in source code"
  exit 1
fi
echo "✓ No secrets in source"

# 6. Package.json checks
echo "Checking package.json..."
node -e "
  const pkg = require('./package.json');
  const checks = [
    [pkg.name, 'name'],
    [pkg.version, 'version'],
    [pkg.bin, 'bin field'],
    [pkg.files, 'files field'],
    [pkg.engines, 'engines field'],
    [pkg.license === 'MIT', 'MIT license'],
    [pkg.description, 'description'],
  ];
  let ok = true;
  checks.forEach(([v, name]) => {
    if (!v) { console.error('✗ Missing: ' + name); ok = false; }
  });
  if (!ok) process.exit(1);
  console.log('✓ package.json complete');
"

echo ""
echo "═══════════════════════════════"
echo "✓ All checks passed. Ready to publish!"
echo ""
echo "Run:"
echo "  npm publish --access public"
echo "  git tag v\$(node -p 'require(\"./package.json\").version') && git push --tags"
