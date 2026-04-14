/**
 * Startup timing instrumentation.
 * Enable with: OPENPAWL_DEBUG_STARTUP=1 openpawl
 * Prints timing table to stderr.
 */

const DEBUG_STARTUP = !!process.env.OPENPAWL_DEBUG_STARTUP;
const _startupT0 = performance.now();
const _startupMarks: { label: string; ts: number }[] = [];

export function mark(label: string): void {
  if (!DEBUG_STARTUP) return;
  _startupMarks.push({ label, ts: performance.now() });
}

export function printStartupTimings(): void {
  if (!DEBUG_STARTUP || _startupMarks.length === 0) return;
  process.stderr.write("\n┌─────────────────────────────────────────────────────────────────┐\n");
  process.stderr.write("│  STARTUP TIMING REPORT                                          │\n");
  process.stderr.write("├──────────┬──────────┬──────────────────────────────────────────┤\n");
  process.stderr.write("│ delta ms │ total ms │ checkpoint                               │\n");
  process.stderr.write("├──────────┼──────────┼──────────────────────────────────────────┤\n");
  let prev = _startupT0;
  for (const m of _startupMarks) {
    const delta = (m.ts - prev).toFixed(1).padStart(8);
    const total = (m.ts - _startupT0).toFixed(1).padStart(8);
    const label = m.label.padEnd(40);
    process.stderr.write(`│ ${delta} │ ${total} │ ${label}│\n`);
    prev = m.ts;
  }
  const uptimeMs = (process.uptime() * 1000).toFixed(1);
  process.stderr.write("├──────────┴──────────┴──────────────────────────────────────────┤\n");
  process.stderr.write(`│  process.uptime: ${uptimeMs}ms`.padEnd(66) + "│\n");
  process.stderr.write("└─────────────────────────────────────────────────────────────────┘\n\n");
}

mark("app/index.ts module loaded (eager imports)");
