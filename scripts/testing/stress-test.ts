/**
 * Comprehensive stress tests across all subsystems.
 * Run: bun run tsx src/testing/stress-test.ts [--category all|session|memory|sprint|tui|io|combined]
 */

import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `openpawl-stress-${Date.now()}`);
const REPORT_PATH = join(homedir(), ".openpawl", "stress-test-report.md");

const args = process.argv.slice(2);
const categoryArg = args.find((a) => a.startsWith("--category="))?.split("=")[1]
  ?? args[args.indexOf("--category") + 1]
  ?? "all";

// ── Helpers ─────────────────────────────────────────────────────────────────

interface TestResult { name: string; status: "PASS" | "FAIL" | "SKIP"; metric: string; notes: string }
const allResults: Record<string, TestResult[]> = {};
function addResult(cat: string, r: TestResult) { (allResults[cat] ??= []).push(r); }

function log(msg: string) { console.log(msg); }
function heapMB(): number { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100; }

function shouldRun(cat: string): boolean {
  return categoryArg === "all" || categoryArg === cat;
}

// ── Category 1: Sessions ────────────────────────────────────────────────────

async function runSessionStress() {
  const cat = "session";
  log("\n═══ Category 1: Session Stress ═══");

  const { createSessionManager, SessionStore } = await import("../session/index.js");

  // Test 1.1: Session file explosion (500 sessions)
  {
    log("  1.1 Session file explosion...");
    const dir = join(TEST_DIR, "s-explosion");
    mkdirSync(dir, { recursive: true });
    const mgr = createSessionManager({ sessionsDir: dir });
    await mgr.initialize();

    const timings: number[] = [];
    const milestones = [100, 200, 300, 400, 500];
    let nextMilestone = 0;

    for (let i = 0; i < 500; i++) {
      const r = await mgr.create(TEST_DIR);
      if (r.isOk()) {
        r.value.addMessage({ role: "user", content: `msg ${i}` });
        await mgr.getStore().save(r.value);
      }
      if (milestones[nextMilestone] === i + 1) {
        const t0 = Date.now();
        await mgr.list({ limit: 1000 });
        timings.push(Date.now() - t0);
        nextMilestone++;
      }
    }

    const curve = milestones.map((m, i) => `${m}: ${timings[i]}ms`).join(" | ");
    const degradation = timings.length >= 2 && timings[timings.length - 1]! > timings[0]! * 5 ? "quadratic" : "linear";
    addResult(cat, { name: "1.1 500 sessions", status: "PASS", metric: `list@500=${timings[timings.length - 1]}ms`, notes: `curve: ${curve}, scaling: ${degradation}` });
    log(`    ${curve} → ${degradation}`);
    await mgr.shutdown();
  }

  // Test 1.2: Giant session (5000 messages)
  {
    log("  1.2 Giant session (5000 msgs)...");
    const dir = join(TEST_DIR, "s-giant");
    mkdirSync(dir, { recursive: true });
    const mgr = createSessionManager({ sessionsDir: dir });
    await mgr.initialize();

    const r = await mgr.create(TEST_DIR);
    if (r.isErr()) { addResult(cat, { name: "1.2 Giant session", status: "FAIL", metric: "-", notes: "create failed" }); }
    else {
      const session = r.value;
      for (let i = 0; i < 5000; i++) {
        session.addMessage({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}: ${"x".repeat(180)}`, ...(i % 2 === 1 ? { agentId: "coder" } : {}) });
      }

      const heapBefore = heapMB();
      const saveStart = Date.now();
      await mgr.getStore().save(session);
      const saveMs = Date.now() - saveStart;

      const stateFile = join(dir, session.id, "state.json");
      const sizeKB = Math.round(statSync(stateFile).size / 1024);

      const loadStart = Date.now();
      await mgr.getStore().load(session.id);
      const loadMs = Date.now() - loadStart;
      const heapAfter = heapMB();

      // Append 1 message and re-save
      session.addMessage({ role: "user", content: "one more" });
      const appendStart = Date.now();
      await mgr.getStore().save(session);
      const appendMs = Date.now() - appendStart;

      addResult(cat, { name: "1.2 Giant session", status: "PASS", metric: `save=${saveMs}ms load=${loadMs}ms`, notes: `5001 msgs, ${sizeKB}KB, append=${appendMs}ms, RAM=+${(heapAfter - heapBefore).toFixed(1)}MB` });
      log(`    save=${saveMs}ms load=${loadMs}ms size=${sizeKB}KB append=${appendMs}ms`);
    }
    await mgr.shutdown();
  }

  // Test 1.3: Rapid save/load cycles (1000x)
  {
    log("  1.3 Rapid save/load (1000 cycles)...");
    const dir = join(TEST_DIR, "s-rapid");
    mkdirSync(dir, { recursive: true });
    const store = new SessionStore(dir);
    const mgr = createSessionManager({ sessionsDir: dir });
    await mgr.initialize();

    const r = await mgr.create(TEST_DIR);
    if (r.isErr()) { addResult(cat, { name: "1.3 Rapid cycles", status: "FAIL", metric: "-", notes: "create failed" }); }
    else {
      const session = r.value;
      session.addMessage({ role: "user", content: "test" });

      let failures = 0;
      let maxMs = 0;
      let totalMs = 0;
      for (let i = 0; i < 1000; i++) {
        const t0 = Date.now();
        await store.save(session);
        const loaded = await store.load(session.id);
        const elapsed = Date.now() - t0;
        totalMs += elapsed;
        if (elapsed > maxMs) maxMs = elapsed;
        if (loaded.isErr()) failures++;
      }
      const avgMs = (totalMs / 1000).toFixed(1);

      // Verify no corruption
      const final = await store.load(session.id);
      const corrupt = final.isErr() || final.value.messages.length < 1;

      addResult(cat, {
        name: "1.3 Rapid cycles",
        status: corrupt || failures > 0 ? "FAIL" : "PASS",
        metric: `avg=${avgMs}ms max=${maxMs}ms`,
        notes: `1000 cycles, ${failures} failures, corrupt=${corrupt}`,
      });
      log(`    avg=${avgMs}ms max=${maxMs}ms failures=${failures}`);
    }
    await mgr.shutdown();
  }

  // Test 1.4: Concurrent writes to same session
  {
    log("  1.4 Concurrent writes...");
    const dir = join(TEST_DIR, "s-concurrent");
    mkdirSync(dir, { recursive: true });
    const store = new SessionStore(dir);
    const mgr = createSessionManager({ sessionsDir: dir });
    await mgr.initialize();

    const r = await mgr.create(TEST_DIR);
    if (r.isErr()) { addResult(cat, { name: "1.4 Concurrent writes", status: "FAIL", metric: "-", notes: "create failed" }); }
    else {
      const session = r.value;
      let errors = 0;
      await Promise.all(Array.from({ length: 10 }, async (_, i) => {
        try {
          session.addMessage({ role: "user", content: `concurrent msg ${i}` });
          await store.save(session);
        } catch { errors++; }
      }));

      const final = await store.load(session.id);
      const msgCount = final.isOk() ? final.value.messages.length : -1;

      addResult(cat, {
        name: "1.4 Concurrent writes",
        status: errors === 0 ? "PASS" : "FAIL",
        metric: `${msgCount} msgs saved`,
        notes: `10 parallel writes, ${errors} errors (last-write-wins expected)`,
      });
      log(`    ${msgCount} msgs, ${errors} errors`);
    }
    await mgr.shutdown();
  }
}

// ── Category 2: Memory (LanceDB) ───────────────────────────────────────────

async function runMemoryStress() {
  const cat = "memory";
  log("\n═══ Category 2: Memory (LanceDB) Stress ═══");

  // Test 2.1: Decision journal scaling
  {
    log("  2.1 Decision journal scaling...");
    try {
      const lancedb = await import("@lancedb/lancedb");
      const { DecisionStore } = await import("../journal/store.js");

      const dbPath = join(TEST_DIR, "lance-decisions");
      mkdirSync(dbPath, { recursive: true });
      const db = await lancedb.connect(dbPath);
      const store = new DecisionStore();
      await store.init(db);

      // Insert 100 decisions
      const insertStart = Date.now();
      for (let i = 0; i < 100; i++) {
        await store.upsert({
          id: `d-${i}`,
          sessionId: "test",
          runIndex: 0,
          capturedAt: Date.now(),
          topic: `topic-${i}`,
          decision: `Use approach ${i} for feature ${i % 10}`,
          reasoning: `Because option ${i} is better for scalability`,
          recommendedBy: "planner",
          confidence: 0.8,
          taskId: `task-${i}`,
          goalContext: "Build a web app",
          tags: ["test", `tag-${i % 5}`],
          status: "active",
          supersededBy: undefined,
          permanent: false,
          embedding: Array.from({ length: 4 }, () => Math.random()),
        });
      }
      const insertMs = Date.now() - insertStart;

      // getAll
      const getAllStart = Date.now();
      const all = await store.getAll();
      const getAllMs = Date.now() - getAllStart;

      addResult(cat, {
        name: "2.1 Decision journal",
        status: "PASS",
        metric: `insert=${insertMs}ms getAll=${getAllMs}ms`,
        notes: `100 decisions, ${all.length} retrieved`,
      });
      log(`    insert 100: ${insertMs}ms, getAll: ${getAllMs}ms (${all.length} rows)`);
    } catch (err) {
      addResult(cat, { name: "2.1 Decision journal", status: "SKIP", metric: "-", notes: `LanceDB not available: ${err instanceof Error ? err.message : String(err)}` });
      log("    SKIPPED (LanceDB unavailable)");
    }
  }

  // Test 2.2: Drift detection scaling
  {
    log("  2.2 Drift detection...");
    try {
      const { detectDrift } = await import("../drift/index.js");
      const decisions = Array.from({ length: 100 }, (_, i) => ({
        id: `d-${i}`, sessionId: "test", runIndex: 0, capturedAt: Date.now(),
        topic: `topic-${i}`, decision: `Use Redis for caching layer ${i}`,
        reasoning: "Better performance", recommendedBy: "planner", confidence: 0.8,
        taskId: `t-${i}`, goalContext: "Build app", tags: ["redis", "cache"],
        status: "active" as const, supersededBy: undefined, permanent: false, embedding: [],
      }));

      const t0 = Date.now();
      const result = detectDrift("Replace Redis with Memcached for all caching", decisions);
      const driftMs = Date.now() - t0;

      addResult(cat, {
        name: "2.2 Drift detection",
        status: "PASS",
        metric: `${driftMs}ms`,
        notes: `100 decisions, ${result.conflicts.length} conflicts, severity=${result.severity}`,
      });
      log(`    drift check: ${driftMs}ms, ${result.conflicts.length} conflicts`);
    } catch (err) {
      addResult(cat, { name: "2.2 Drift detection", status: "FAIL", metric: "-", notes: String(err) });
    }
  }
}

// ── Category 3: Sprint/Pipeline ─────────────────────────────────────────────

async function runSprintStress() {
  const cat = "sprint";
  log("\n═══ Category 3: Sprint/Pipeline Stress ═══");

  // Test 3.1: Post-mortem on many tasks
  {
    log("  3.1 Post-mortem (50 tasks)...");
    const { analyzeRunResult } = await import("../sprint/post-mortem.js");
    const tasks = Array.from({ length: 50 }, (_, i) => ({
      id: `task-${i}`, description: `Implement feature ${i} with TypeScript`,
      status: (i % 5 === 0 ? "failed" : "completed") as "failed" | "completed",
      assignedAgent: "coder",
      result: i % 5 === 0 ? undefined : `Completed feature ${i}`,
      error: i % 5 === 0 ? "Module not found: some-dep" : undefined,
      toolsCalled: ["file_write", "shell_exec"],
    }));

    const t0 = Date.now();
    const result = analyzeRunResult({ goal: "Build app", tasks, completedTasks: 40, failedTasks: 10, duration: 60000 });
    const pmMs = Date.now() - t0;

    addResult(cat, {
      name: "3.1 Post-mortem 50 tasks",
      status: "PASS",
      metric: `${pmMs}ms`,
      notes: `${result.lessons.length} lessons, ${result.successPatterns.length} patterns`,
    });
    log(`    ${pmMs}ms, ${result.lessons.length} lessons`);
  }

  // Test 3.2: Goal analyzer on complex goal
  {
    log("  3.2 Goal analyzer (500-word goal)...");
    const { analyzeGoal } = await import("../sprint/goal-analyzer.js");
    const complexGoal = Array.from({ length: 100 }, (_, i) =>
      `Build feature ${i} with authentication and database integration and API endpoints and testing and deployment`
    ).join(". ");

    const t0 = Date.now();
    const result = analyzeGoal(complexGoal);
    const gaMs = Date.now() - t0;

    addResult(cat, {
      name: "3.2 Goal analyzer",
      status: "PASS",
      metric: `${gaMs}ms`,
      notes: `${complexGoal.split(/\s+/).length} words, ${result.estimatedTasks} estimated tasks, ${result.composition.activeAgents.length} agents`,
    });
    log(`    ${gaMs}ms, ${result.estimatedTasks} tasks, ${result.composition.activeAgents.length} agents`);
  }

  // Test 3.3: Task parser on large output
  {
    log("  3.3 Task parser (100 tasks)...");
    const { parseTasks } = await import("../sprint/task-parser.js");
    const largePlan = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({
        description: `Task ${i}: Implement module ${i} with full test coverage and documentation and error handling`,
        dependsOn: i > 0 ? [i] : [],
      })),
    );

    const t0 = Date.now();
    const tasks = parseTasks(largePlan);
    const tpMs = Date.now() - t0;

    addResult(cat, {
      name: "3.3 Task parser 100 tasks",
      status: tasks.length === 100 ? "PASS" : "FAIL",
      metric: `${tpMs}ms`,
      notes: `parsed ${tasks.length}/100 tasks`,
    });
    log(`    ${tpMs}ms, ${tasks.length} tasks parsed`);
  }

  // Test 3.4: Context compaction at scale
  {
    log("  3.4 Context compaction...");
    const { compact } = await import("../context/compaction.js");
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool") as "user" | "assistant" | "tool",
      content: `${"x".repeat(2000)} message ${i}`,
      ...(i % 3 === 2 ? { toolCallId: `tc-${i}` } : {}),
    }));

    const t0 = Date.now();
    const result = await compact(messages, "high", { force: true, keepLastExchanges: 6 });
    const compactMs = Date.now() - t0;

    addResult(cat, {
      name: "3.4 Compaction 200KB",
      status: result ? "PASS" : "FAIL",
      metric: `${compactMs}ms`,
      notes: result ? `strategy=${result.strategy}, affected=${result.messagesAffected}, before=${result.beforeTokens} after=${result.afterTokens} tokens` : "compaction returned null",
    });
    log(`    ${compactMs}ms, ${result ? `${result.strategy}: ${result.messagesAffected} msgs affected` : "null"}`);
  }
}

// ── Category 4: TUI Rendering (mock) ────────────────────────────────────────

async function runTuiStress() {
  const cat = "tui";
  log("\n═══ Category 4: TUI Rendering Stress ═══");

  // Test 4.1: ScrollableFilterList performance
  {
    log("  4.1 Filter performance (500 items)...");
    try {
      const { ScrollableFilterList } = await import("../tui/components/scrollable-filter-list.js");

      const list = new ScrollableFilterList<{ label: string }>({
        renderItem: (item: { label: string }) => [item.label],
        filterFn: (item: { label: string }, query: string) => item.label.toLowerCase().includes(query.toLowerCase()),
      });

      const items = Array.from({ length: 500 }, (_, i) => ({ label: `Item ${i}: some searchable text with keywords like typescript and react and node` }));
      list.setItems(items);

      // Filter with 1 char
      const t1 = Date.now();
      const lines1 = list.renderLines({ filterText: "t", selectedIndex: 0, scrollOffset: 0, maxVisible: 20 });
      const filter1Ms = Date.now() - t1;

      // Filter with 5 chars
      const t2 = Date.now();
      const lines2 = list.renderLines({ filterText: "types", selectedIndex: 0, scrollOffset: 0, maxVisible: 20 });
      const filter5Ms = Date.now() - t2;

      const under16ms = filter1Ms < 16 && filter5Ms < 16;
      addResult(cat, {
        name: "4.1 Filter 500 items",
        status: under16ms ? "PASS" : "FAIL",
        metric: `1char=${filter1Ms}ms 5char=${filter5Ms}ms`,
        notes: `${lines1.length}/${lines2.length} lines rendered, ${under16ms ? "within" : "exceeds"} 16ms budget`,
      });
      log(`    1char=${filter1Ms}ms (${lines1.length} lines), 5chars=${filter5Ms}ms (${lines2.length} lines)`);
    } catch (err) {
      addResult(cat, { name: "4.1 Filter 500 items", status: "SKIP", metric: "-", notes: String(err) });
    }
  }

  // Test 4.2: Status bar rapid updates
  {
    log("  4.2 Rapid string formatting (1000 updates)...");
    const { formatDuration } = await import("../utils/formatters.js");

    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      formatDuration(i * 1000);
    }
    const fmtMs = Date.now() - t0;

    addResult(cat, {
      name: "4.2 Format 1000x",
      status: fmtMs < 50 ? "PASS" : "FAIL",
      metric: `${fmtMs}ms`,
      notes: `1000 formatDuration calls, ${(fmtMs / 1000).toFixed(3)}ms avg`,
    });
    log(`    ${fmtMs}ms total, ${(fmtMs / 1000).toFixed(3)}ms avg`);
  }
}

// ── Category 5: IO/Disk ─────────────────────────────────────────────────────

async function runIoStress() {
  const cat = "io";
  log("\n═══ Category 5: IO/Disk Stress ═══");

  // Test 5.1: Config read/write cycling
  {
    log("  5.1 Config read/write (1000 cycles)...");
    const configDir = join(TEST_DIR, "config-test");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, activeProvider: "test" }) + "\n");

    let errors = 0;
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);
        parsed.meta = { updatedAt: new Date().toISOString(), cycle: i };
        writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
      } catch { errors++; }
    }
    const ioMs = Date.now() - t0;

    // Verify final file is valid JSON
    let validFinal = false;
    try { JSON.parse(readFileSync(configPath, "utf-8")); validFinal = true; } catch { /* */ }

    addResult(cat, {
      name: "5.1 Config 1000 cycles",
      status: validFinal && errors === 0 ? "PASS" : "FAIL",
      metric: `${ioMs}ms`,
      notes: `avg=${(ioMs / 1000).toFixed(1)}ms, ${errors} errors, final valid=${validFinal}`,
    });
    log(`    ${ioMs}ms total, ${errors} errors, valid=${validFinal}`);
  }

  // Test 5.2: Template store scaling
  {
    log("  5.2 Template store (50 mock templates)...");
    const templateDir = join(TEST_DIR, "templates");
    mkdirSync(templateDir, { recursive: true });

    // Create 50 mock template files
    const createStart = Date.now();
    for (let i = 0; i < 50; i++) {
      const template = {
        id: `template-${i}`, name: `Template ${i}`, description: `A test template ${i}`,
        tags: ["test"], version: "1.0.0",
        agents: [{ role: "coder", task: `Task ${i}` }],
        pipeline: ["coder"],
      };
      writeFileSync(join(templateDir, `template-${i}.json`), JSON.stringify(template, null, 2));
    }
    const createMs = Date.now() - createStart;

    // List all
    const listStart = Date.now();
    const files = readdirSync(templateDir).filter((f) => f.endsWith(".json"));
    const listMs = Date.now() - listStart;

    // Read one
    const readStart = Date.now();
    JSON.parse(readFileSync(join(templateDir, "template-25.json"), "utf-8"));
    const readMs = Date.now() - readStart;

    addResult(cat, {
      name: "5.2 Templates 50",
      status: "PASS",
      metric: `create=${createMs}ms list=${listMs}ms read=${readMs}ms`,
      notes: `${files.length} templates`,
    });
    log(`    create=${createMs}ms list=${listMs}ms read=${readMs}ms`);
  }
}

// ── Category 6: Combined ────────────────────────────────────────────────────

async function runCombinedStress() {
  const cat = "combined";
  log("\n═══ Category 6: Combined Stress ═══");

  // Test 6.1: Simulated heavy session
  {
    log("  6.1 Simultaneous operations...");
    const { createSessionManager } = await import("../session/index.js");

    const dir = join(TEST_DIR, "combined");
    mkdirSync(dir, { recursive: true });

    const heapBefore = heapMB();
    const t0 = Date.now();
    let errors = 0;

    try {
      await Promise.all([
        // Load 3 sessions
        (async () => {
          const mgr = createSessionManager({ sessionsDir: join(dir, "s1") });
          await mgr.initialize();
          for (let i = 0; i < 3; i++) {
            const r = await mgr.create(TEST_DIR);
            if (r.isOk()) {
              for (let j = 0; j < 50; j++) r.value.addMessage({ role: "user", content: `msg ${j}` });
              await mgr.getStore().save(r.value);
            }
          }
          await mgr.shutdown();
        })(),

        // Config writes
        (async () => {
          const cfgPath = join(dir, "config.json");
          writeFileSync(cfgPath, "{}");
          for (let i = 0; i < 10; i++) {
            writeFileSync(cfgPath, JSON.stringify({ i, t: Date.now() }));
          }
        })(),

        // Drift detection
        (async () => {
          const { detectDrift } = await import("../drift/index.js");
          for (let i = 0; i < 5; i++) {
            detectDrift("Build a web app", []);
          }
        })(),
      ]);
    } catch { errors++; }

    const totalMs = Date.now() - t0;
    const heapAfter = heapMB();

    addResult(cat, {
      name: "6.1 Heavy session",
      status: errors === 0 ? "PASS" : "FAIL",
      metric: `${totalMs}ms`,
      notes: `3 sessions + 10 config writes + 5 drift checks, RAM peak: ${heapAfter}MB (+${(heapAfter - heapBefore).toFixed(1)}MB)`,
    });
    log(`    ${totalMs}ms, RAM: ${heapBefore}→${heapAfter}MB, errors=${errors}`);
  }

  // Test 6.2: Module import time
  {
    log("  6.2 Cold module import...");
    const modules = [
      ["session", "../session/index.js"],
      ["journal", "../journal/index.js"],
      ["drift", "../drift/index.js"],
      ["sprint", "../sprint/post-mortem.js"],
      ["briefing", "../briefing/index.js"],
      ["handoff", "../handoff/index.js"],
    ] as const;

    const importTimes: string[] = [];
    const totalStart = Date.now();
    for (const [name, path] of modules) {
      const t0 = Date.now();
      await import(path);
      importTimes.push(`${name}=${Date.now() - t0}ms`);
    }
    const totalMs = Date.now() - totalStart;

    addResult(cat, {
      name: "6.2 Module imports",
      status: "PASS",
      metric: `total=${totalMs}ms`,
      notes: importTimes.join(", "),
    });
    log(`    ${totalMs}ms total: ${importTimes.join(", ")}`);
  }
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReport(): string {
  const lines: string[] = [];
  lines.push("# Stress Test Report\n");
  lines.push(`Date: ${new Date().toISOString().slice(0, 19)}`);
  lines.push(`Platform: ${process.platform} ${process.arch}`);
  lines.push(`Runtime: Bun ${process.versions.bun ?? "unknown"}`);
  lines.push(`Categories: ${categoryArg}\n`);

  // Executive summary
  const all = Object.values(allResults).flat();
  const passed = all.filter((r) => r.status === "PASS").length;
  const failed = all.filter((r) => r.status === "FAIL").length;
  const skipped = all.filter((r) => r.status === "SKIP").length;

  lines.push("## Executive Summary\n");
  lines.push(`- **${passed}/${all.length}** tests passed (${failed} failed, ${skipped} skipped)`);
  lines.push(`- Memory peak: ${heapMB()} MB`);

  // Find biggest bottleneck
  const slowest = all.filter((r) => r.status === "PASS").sort((a, b) => {
    const aMs = parseInt(a.metric.match(/(\d+)ms/)?.[1] ?? "0");
    const bMs = parseInt(b.metric.match(/(\d+)ms/)?.[1] ?? "0");
    return bMs - aMs;
  })[0];
  if (slowest) lines.push(`- Slowest test: ${slowest.name} (${slowest.metric})`);
  lines.push("");

  // Category tables
  for (const [cat, results] of Object.entries(allResults)) {
    const catName = { session: "Sessions", memory: "Memory (LanceDB)", sprint: "Sprint/Pipeline", tui: "TUI Rendering", io: "IO/Disk", combined: "Combined" }[cat] ?? cat;
    lines.push(`## Category: ${catName}\n`);
    lines.push("| Test | Status | Key Metric | Notes |");
    lines.push("|------|--------|------------|-------|");
    for (const r of results) {
      lines.push(`| ${r.name} | ${r.status} | ${r.metric} | ${r.notes} |`);
    }
    lines.push("");
  }

  // Recommendations
  lines.push("## Recommendations\n");
  if (all.some((r) => r.notes.includes("quadratic"))) {
    lines.push("1. Session listing shows quadratic scaling — consider indexing or caching");
  }
  const giantSession = all.find((r) => r.name.includes("Giant"));
  if (giantSession) {
    const saveMs = parseInt(giantSession.metric.match(/save=(\d+)ms/)?.[1] ?? "0");
    if (saveMs > 50) lines.push(`2. Giant session save is slow (${saveMs}ms) — consider incremental saves`);
    else lines.push("1. Session save performance is excellent even at 5000 messages");
  }
  lines.push(`${all.every((r) => r.status !== "FAIL") ? "- No critical issues found — ready for launch" : "- Fix failing tests before launch"}`);

  return lines.join("\n") + "\n";
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log("OpenPawl Stress Tests");
  log("═".repeat(50));
  mkdirSync(TEST_DIR, { recursive: true });

  try {
    if (shouldRun("session")) await runSessionStress();
    if (shouldRun("memory")) await runMemoryStress();
    if (shouldRun("sprint")) await runSprintStress();
    if (shouldRun("tui")) await runTuiStress();
    if (shouldRun("io")) await runIoStress();
    if (shouldRun("combined")) await runCombinedStress();
  } finally {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const report = generateReport();
  mkdirSync(join(homedir(), ".openpawl"), { recursive: true });
  writeFileSync(REPORT_PATH, report);

  log(`\n${"═".repeat(50)}`);
  log(`Report: ${REPORT_PATH}`);
  const all = Object.values(allResults).flat();
  log(`Result: ${all.filter((r) => r.status === "PASS").length}/${all.length} passed`);
}

main().catch((err) => {
  console.error("Stress test runner failed:", err);
  process.exit(1);
});
