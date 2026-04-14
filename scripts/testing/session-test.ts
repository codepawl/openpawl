/**
 * Session management end-to-end tests + performance benchmarks.
 * Run: bun run tsx src/testing/session-test.ts
 */

import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { createSessionManager, Session, SessionStore } from "../session/index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `openpawl-session-test-${Date.now()}`);
const REPORT_PATH = join(homedir(), ".openpawl", "session-test-report.md");

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  timeMs: number;
  notes: string;
}

const results: TestResult[] = [];
const perfRows: Array<{ messages: number; saveMs: number; loadMs: number; sizeKB: number; ramMB: number }> = [];
const memRows: Array<{ state: string; heapMB: number; delta: string }> = [];
const stressResults: TestResult[] = [];

function log(msg: string) { console.log(msg); }
function pass(name: string, ms: number, notes = "") { results.push({ name, status: "PASS", timeMs: ms, notes }); log(`  ✓ ${name} (${ms}ms)`); }
function fail(name: string, ms: number, notes: string) { results.push({ name, status: "FAIL", timeMs: ms, notes }); log(`  ✗ ${name} (${ms}ms) — ${notes}`); }

function heapMB(): number {
  if (typeof globalThis.gc === "function") globalThis.gc();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
}

function createMgr(subdir: string) {
  const dir = join(TEST_DIR, subdir);
  mkdirSync(dir, { recursive: true });
  return createSessionManager({ sessionsDir: dir });
}

function mockMessage(i: number, sizeBytes = 100) {
  const content = `Message ${i}: ${"x".repeat(Math.max(0, sizeBytes - 20))}`;
  return { role: "user" as const, content };
}

function mockAssistantMessage(i: number, sizeBytes = 200) {
  const content = `Response ${i}: ${"y".repeat(Math.max(0, sizeBytes - 20))}`;
  return { role: "assistant" as const, content, agentId: "coder" };
}

// ── Part 1: CRUD Tests ──────────────────────────────────────────────────────

async function testCreate() {
  const t0 = Date.now();
  const mgr = createMgr("crud-create");
  await mgr.initialize();

  const res = await mgr.create(TEST_DIR);
  if (res.isErr()) { fail("Create", Date.now() - t0, `create failed: ${res.error.type}`); return null; }

  const session = res.value;
  session.addMessage(mockMessage(1));
  session.addMessage(mockAssistantMessage(1));
  session.addMessage(mockMessage(2));

  await mgr.getStore().save(session);

  const dir = join(TEST_DIR, "crud-create", session.id);
  const stateFile = join(dir, "state.json");
  const fileExists = existsSync(stateFile);
  const fileSize = fileExists ? statSync(stateFile).size : 0;

  if (!fileExists) { fail("Create", Date.now() - t0, "state.json not found"); return null; }
  pass("Create", Date.now() - t0, `id=${session.id}, size=${fileSize}B, 3 messages`);
  await mgr.shutdown();
  return session.id;
}

async function testList() {
  const t0 = Date.now();
  const mgr = createMgr("crud-list");
  await mgr.initialize();

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await mgr.create(TEST_DIR);
    if (res.isOk()) {
      res.value.setTitle(`Session ${i + 1}`);
      res.value.addMessage(mockMessage(i));
      await mgr.getStore().save(res.value);
      ids.push(res.value.id);
    }
  }

  const listRes = await mgr.list({ limit: 10 });
  if (listRes.isErr()) { fail("List", Date.now() - t0, `list failed: ${listRes.error.type}`); return; }

  const items = listRes.value;
  const allFound = ids.every((id) => items.some((it) => it.id === id));
  if (items.length < 5) { fail("List", Date.now() - t0, `expected 5, got ${items.length}`); return; }
  if (!allFound) { fail("List", Date.now() - t0, "not all sessions found"); return; }

  pass("List", Date.now() - t0, `${items.length} sessions listed`);
  await mgr.shutdown();
}

async function testLoad(sessionId: string | null) {
  if (!sessionId) { fail("Load", 0, "skipped (no session from create)"); return; }
  const t0 = Date.now();
  const store = new SessionStore(join(TEST_DIR, "crud-create"));

  const res = await store.load(sessionId);
  if (res.isErr()) { fail("Load", Date.now() - t0, `load failed: ${res.error.type}`); return; }

  const session = res.value;
  const msgs = session.messages;
  if (msgs.length !== 3) { fail("Load", Date.now() - t0, `expected 3 messages, got ${msgs.length}`); return; }
  if (!session.getState().title) { fail("Load", Date.now() - t0, "title missing"); return; }

  pass("Load", Date.now() - t0, `${msgs.length} messages, title="${session.getState().title}"`);
}

async function testResume() {
  const t0 = Date.now();
  const mgr = createMgr("crud-resume");
  await mgr.initialize();

  const createRes = await mgr.create(TEST_DIR);
  if (createRes.isErr()) { fail("Resume", Date.now() - t0, "create failed"); return; }

  const session = createRes.value;
  session.addMessage(mockMessage(1));
  session.addMessage(mockAssistantMessage(1));
  session.addMessage(mockMessage(2));
  await mgr.getStore().save(session);
  const sid = session.id;

  // Create a new session (archives the first)
  await mgr.create(TEST_DIR);

  // Resume the first
  const resumeRes = await mgr.resume(sid);
  if (resumeRes.isErr()) { fail("Resume", Date.now() - t0, `resume failed: ${resumeRes.error.type}`); return; }

  const resumed = resumeRes.value;
  resumed.addMessage(mockAssistantMessage(2));
  resumed.addMessage(mockMessage(3));
  await mgr.getStore().save(resumed);

  // Reload and verify
  const reloadRes = await mgr.getStore().load(sid);
  if (reloadRes.isErr()) { fail("Resume", Date.now() - t0, "reload failed"); return; }
  const reloaded = reloadRes.value;

  if (reloaded.messages.length !== 5) {
    fail("Resume", Date.now() - t0, `expected 5 messages, got ${reloaded.messages.length}`);
    return;
  }

  pass("Resume", Date.now() - t0, `5 messages after resume + append`);
  await mgr.shutdown();
}

async function testDelete() {
  const t0 = Date.now();
  const mgr = createMgr("crud-delete");
  await mgr.initialize();

  const res = await mgr.create(TEST_DIR);
  if (res.isErr()) { fail("Delete", Date.now() - t0, "create failed"); return; }
  const sid = res.value.id;
  res.value.addMessage(mockMessage(1));
  await mgr.getStore().save(res.value);

  // Create another session so deletion target isn't active
  await mgr.create(TEST_DIR);

  const delRes = await mgr.delete(sid);
  if (delRes.isErr()) { fail("Delete", Date.now() - t0, `delete failed: ${delRes.error.type}`); return; }

  const stateFile = join(TEST_DIR, "crud-delete", sid, "state.json");
  if (existsSync(stateFile)) { fail("Delete", Date.now() - t0, "file still exists"); return; }

  const listRes = await mgr.list();
  if (listRes.isOk() && listRes.value.some((it) => it.id === sid)) {
    fail("Delete", Date.now() - t0, "still in list"); return;
  }

  pass("Delete", Date.now() - t0, "file removed, not in list");
  await mgr.shutdown();
}

async function testClearAll() {
  const t0 = Date.now();
  const mgr = createMgr("crud-clear");
  await mgr.initialize();

  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await mgr.create(TEST_DIR);
    if (r.isOk()) {
      r.value.addMessage(mockMessage(i));
      await mgr.getStore().save(r.value);
      ids.push(r.value.id);
    }
  }

  const currentId = ids[ids.length - 1]!;

  // Archive all except current, then purge
  for (const id of ids) {
    if (id !== currentId) await mgr.archive(id);
  }
  const purgeRes = await mgr.getStore().purgeArchived();
  const purged = purgeRes.isOk() ? purgeRes.value : 0;

  const listRes = await mgr.list();
  const remaining = listRes.isOk() ? listRes.value.length : -1;

  if (remaining > 1) { fail("Clear all", Date.now() - t0, `${remaining} sessions remain (expected 1)`); }
  else { pass("Clear all", Date.now() - t0, `purged ${purged}, ${remaining} remaining`); }
  await mgr.shutdown();
}

// ── Part 2: Performance Benchmarks ──────────────────────────────────────────

async function testSizeScaling() {
  log("\n  Performance: size scaling...");
  const counts = [10, 50, 100, 500, 1000];

  for (const n of counts) {
    const mgr = createMgr(`perf-${n}`);
    await mgr.initialize();

    const res = await mgr.create(TEST_DIR);
    if (res.isErr()) continue;
    const session = res.value;

    for (let i = 0; i < n; i++) {
      session.addMessage(i % 2 === 0 ? mockMessage(i) : mockAssistantMessage(i));
    }

    const heapBefore = heapMB();

    // Measure save
    const saveStart = Date.now();
    await mgr.getStore().save(session);
    const saveMs = Date.now() - saveStart;

    // Get file size
    const stateFile = join(TEST_DIR, `perf-${n}`, session.id, "state.json");
    const sizeKB = existsSync(stateFile) ? Math.round(statSync(stateFile).size / 1024 * 10) / 10 : 0;

    // Measure load
    const loadStart = Date.now();
    await mgr.getStore().load(session.id);
    const loadMs = Date.now() - loadStart;

    const heapAfter = heapMB();
    const ramMB = Math.round((heapAfter - heapBefore) * 100) / 100;

    perfRows.push({ messages: n, saveMs, loadMs, sizeKB, ramMB: Math.max(0, ramMB) });
    log(`    ${String(n).padStart(5)} msgs: save=${saveMs}ms load=${loadMs}ms size=${sizeKB}KB`);

    await mgr.shutdown();
  }
}

async function testConcurrent() {
  const t0 = Date.now();
  const mgr = createMgr("perf-concurrent");
  await mgr.initialize();

  const sessions: Session[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await mgr.create(TEST_DIR);
    if (r.isOk()) sessions.push(r.value);
  }

  // Rapid interleaved writes
  let ops = 0;
  const writeStart = Date.now();
  for (let round = 0; round < 10; round++) {
    await Promise.all(sessions.map(async (s) => {
      s.addMessage(mockMessage(round));
      await mgr.getStore().save(s);
      ops++;
    }));
  }
  const writeMs = Date.now() - writeStart;

  // Verify no corruption
  let corrupt = false;
  for (const s of sessions) {
    const loadRes = await mgr.getStore().load(s.id);
    if (loadRes.isErr()) { corrupt = true; break; }
    if (loadRes.value.messages.length < 10) { corrupt = true; break; }
  }

  const opsPerSec = Math.round(ops / (writeMs / 1000));
  if (corrupt) { fail("Concurrent", Date.now() - t0, "data corruption detected"); }
  else { pass("Concurrent", Date.now() - t0, `${ops} ops in ${writeMs}ms (${opsPerSec} ops/sec)`); }
  await mgr.shutdown();
}

async function testMemoryFootprint() {
  log("\n  Memory footprint...");
  const baseHeap = heapMB();
  memRows.push({ state: "Idle (no sessions)", heapMB: baseHeap, delta: "-" });

  // Small session
  const mgr = createMgr("perf-mem");
  await mgr.initialize();
  const r1 = await mgr.create(TEST_DIR);
  if (r1.isOk()) {
    for (let i = 0; i < 10; i++) r1.value.addMessage(mockMessage(i));
    await mgr.getStore().save(r1.value);
  }
  const heap1 = heapMB();
  memRows.push({ state: "1 small session (10 msgs)", heapMB: heap1, delta: `+${(heap1 - baseHeap).toFixed(2)}` });

  // Large session
  const r2 = await mgr.create(TEST_DIR);
  if (r2.isOk()) {
    for (let i = 0; i < 500; i++) r2.value.addMessage(mockMessage(i, 500));
    await mgr.getStore().save(r2.value);
  }
  const heap2 = heapMB();
  memRows.push({ state: "1 large session (500 msgs)", heapMB: heap2, delta: `+${(heap2 - heap1).toFixed(2)}` });

  // 5 sessions loaded
  for (let i = 0; i < 3; i++) {
    const r = await mgr.create(TEST_DIR);
    if (r.isOk()) {
      for (let j = 0; j < 50; j++) r.value.addMessage(mockMessage(j));
      await mgr.getStore().save(r.value);
    }
  }
  const heap3 = heapMB();
  memRows.push({ state: "5 sessions loaded", heapMB: heap3, delta: `+${(heap3 - heap2).toFixed(2)}` });

  await mgr.shutdown();
  const heapFinal = heapMB();
  memRows.push({ state: "After shutdown", heapMB: heapFinal, delta: `${(heapFinal - heap3).toFixed(2)}` });

  for (const row of memRows) {
    log(`    ${row.state.padEnd(30)} ${String(row.heapMB).padStart(8)}MB  ${row.delta}`);
  }
}

async function testToolOutputs() {
  const t0 = Date.now();
  const mgr = createMgr("perf-tools");
  await mgr.initialize();

  const res = await mgr.create(TEST_DIR);
  if (res.isErr()) { fail("Tool outputs", Date.now() - t0, "create failed"); return; }
  const session = res.value;

  // 20 messages with large tool outputs
  for (let i = 0; i < 20; i++) {
    const toolOutput = `// file_write output\n${"const x = " + i + ";\n".repeat(25)}`;
    session.addMessage({ role: "user", content: `Write file ${i}.ts` });
    session.addMessage({
      role: "tool",
      content: toolOutput,
      toolCallId: `tool-${i}`,
      metadata: { toolName: "file_write", path: `src/file-${i}.ts` },
    });
  }

  const saveStart = Date.now();
  await mgr.getStore().save(session);
  const saveMs = Date.now() - saveStart;

  const stateFile = join(TEST_DIR, "perf-tools", session.id, "state.json");
  const sizeKB = existsSync(stateFile) ? Math.round(statSync(stateFile).size / 1024 * 10) / 10 : 0;

  const loadStart = Date.now();
  const loadRes = await mgr.getStore().load(session.id);
  const loadMs = Date.now() - loadStart;

  if (loadRes.isErr()) { fail("Tool outputs", Date.now() - t0, "reload failed"); return; }
  if (loadRes.value.messages.length !== 40) { fail("Tool outputs", Date.now() - t0, `expected 40 msgs, got ${loadRes.value.messages.length}`); return; }

  pass("Tool outputs", Date.now() - t0, `40 msgs, save=${saveMs}ms, load=${loadMs}ms, size=${sizeKB}KB`);
  await mgr.shutdown();
}

// ── Part 3: Stress Tests ────────────────────────────────────────────────────

async function testManySessions() {
  const t0 = Date.now();
  const mgr = createMgr("stress-many");
  await mgr.initialize();

  // Create 100 sessions
  const createStart = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await mgr.create(TEST_DIR);
    if (r.isOk()) {
      r.value.addMessage(mockMessage(i));
      await mgr.getStore().save(r.value);
      ids.push(r.value.id);
    }
  }
  const createMs = Date.now() - createStart;

  // List all
  const listStart = Date.now();
  const listRes = await mgr.list({ limit: 200 });
  const listMs = Date.now() - listStart;
  const listCount = listRes.isOk() ? listRes.value.length : 0;

  // Delete all
  const deleteStart = Date.now();
  for (const id of ids) {
    await mgr.delete(id);
  }
  const deleteMs = Date.now() - deleteStart;

  // Verify disk clean
  const afterList = await mgr.list({ limit: 200 });
  const afterCount = afterList.isOk() ? afterList.value.length : -1;

  if (afterCount > 0) {
    stressResults.push({ name: "100 sessions", status: "FAIL", timeMs: Date.now() - t0, notes: `${afterCount} remain after delete` });
  } else {
    stressResults.push({
      name: "100 sessions",
      status: "PASS",
      timeMs: Date.now() - t0,
      notes: `create=${createMs}ms, list=${listMs}ms (${listCount}), delete=${deleteMs}ms`,
    });
  }
  log(`    100 sessions: create=${createMs}ms list=${listMs}ms delete=${deleteMs}ms`);
  await mgr.shutdown();
}

async function testLargeContent() {
  const t0 = Date.now();
  const mgr = createMgr("stress-large");
  await mgr.initialize();

  const res = await mgr.create(TEST_DIR);
  if (res.isErr()) { stressResults.push({ name: "Large content", status: "FAIL", timeMs: 0, notes: "create failed" }); return; }
  const session = res.value;

  // 5 messages of ~50KB each
  const largeContent = "a".repeat(50 * 1024);
  const contentHash = Buffer.from(largeContent).length; // simple size check
  for (let i = 0; i < 5; i++) {
    session.addMessage({ role: "user", content: `Msg ${i}: ${largeContent}` });
  }

  const heapBefore = heapMB();
  const saveStart = Date.now();
  await mgr.getStore().save(session);
  const saveMs = Date.now() - saveStart;

  const stateFile = join(TEST_DIR, "stress-large", session.id, "state.json");
  const sizeKB = existsSync(stateFile) ? Math.round(statSync(stateFile).size / 1024) : 0;

  const loadStart = Date.now();
  const loadRes = await mgr.getStore().load(session.id);
  const loadMs = Date.now() - loadStart;

  const heapAfter = heapMB();

  if (loadRes.isErr()) {
    stressResults.push({ name: "Large content", status: "FAIL", timeMs: Date.now() - t0, notes: "reload failed" });
    return;
  }

  // Verify content integrity
  const firstMsg = loadRes.value.messages[0]!;
  const intact = firstMsg.content.length >= contentHash;

  stressResults.push({
    name: "Large content",
    status: intact ? "PASS" : "FAIL",
    timeMs: Date.now() - t0,
    notes: `save=${saveMs}ms, load=${loadMs}ms, size=${sizeKB}KB, RAM=+${(heapAfter - heapBefore).toFixed(1)}MB, integrity=${intact ? "ok" : "FAILED"}`,
  });
  log(`    Large content: save=${saveMs}ms load=${loadMs}ms size=${sizeKB}KB`);
  await mgr.shutdown();
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReport(): string {
  const lines: string[] = [];
  lines.push("# Session Test Report\n");
  lines.push(`Date: ${new Date().toISOString().slice(0, 19)}`);
  lines.push(`Platform: ${process.platform} ${process.arch}`);
  lines.push(`Runtime: Bun ${process.versions.bun ?? "unknown"}\n`);

  lines.push("## CRUD Tests\n");
  lines.push("| Test | Status | Time | Notes |");
  lines.push("|------|--------|------|-------|");
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.status} | ${r.timeMs}ms | ${r.notes} |`);
  }

  lines.push("\n## Performance: Message Scaling\n");
  lines.push("| Messages | Save (ms) | Load (ms) | Size (KB) | RAM (MB) |");
  lines.push("|----------|-----------|-----------|-----------|----------|");
  for (const r of perfRows) {
    lines.push(`| ${r.messages} | ${r.saveMs} | ${r.loadMs} | ${r.sizeKB} | ${r.ramMB} |`);
  }

  lines.push("\n## Memory Footprint\n");
  lines.push("| State | Heap (MB) | Delta |");
  lines.push("|-------|-----------|-------|");
  for (const r of memRows) {
    lines.push(`| ${r.state} | ${r.heapMB} | ${r.delta} |`);
  }

  lines.push("\n## Stress Tests\n");
  lines.push("| Test | Status | Time | Notes |");
  lines.push("|------|--------|------|-------|");
  for (const r of stressResults) {
    lines.push(`| ${r.name} | ${r.status} | ${r.timeMs}ms | ${r.notes} |`);
  }

  const allResults = [...results, ...stressResults];
  const totalPass = allResults.filter((r) => r.status === "PASS").length;
  const totalFail = allResults.filter((r) => r.status === "FAIL").length;

  lines.push("\n## Summary\n");
  lines.push(`**${totalPass}/${allResults.length} tests passed** (${totalFail} failed)\n`);

  if (perfRows.length > 0) {
    const p1000 = perfRows.find((r) => r.messages === 1000);
    if (p1000) {
      lines.push("### Findings\n");
      lines.push(`- 1000-message session: save=${p1000.saveMs}ms, load=${p1000.loadMs}ms, size=${p1000.sizeKB}KB`);
      if (p1000.saveMs > 100) lines.push("- Warning: save time > 100ms for large sessions");
      if (p1000.sizeKB > 500) lines.push("- Warning: session file > 500KB for 1000 messages");
    }
  }

  return lines.join("\n") + "\n";
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log("Session Management Tests");
  log("═".repeat(50));
  mkdirSync(TEST_DIR, { recursive: true });

  try {
    // Part 1: CRUD
    log("\n─── Part 1: CRUD Tests ───");
    const createdId = await testCreate();
    await testList();
    await testLoad(createdId);
    await testResume();
    await testDelete();
    await testClearAll();

    // Part 2: Performance
    log("\n─── Part 2: Performance ───");
    await testSizeScaling();
    await testConcurrent();
    await testMemoryFootprint();
    await testToolOutputs();

    // Part 3: Stress
    log("\n─── Part 3: Stress Tests ───");
    await testManySessions();
    await testLargeContent();

  } finally {
    // Cleanup test directory
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // Generate and save report
  const report = generateReport();
  mkdirSync(join(homedir(), ".openpawl"), { recursive: true });
  writeFileSync(REPORT_PATH, report);
  log(`\n${"═".repeat(50)}`);
  log(`Report saved: ${REPORT_PATH}`);

  const allResults = [...results, ...stressResults];
  const totalPass = allResults.filter((r) => r.status === "PASS").length;
  log(`Result: ${totalPass}/${allResults.length} passed`);
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
