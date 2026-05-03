/**
 * Solo-mode benchmark — runs canonical tasks against the headless solo runner
 * and scores the resulting code quality.
 *
 * Usage:
 *   bun run tsx scripts/testing/benchmark.ts [--suite all|orchestration|quality|swebench] [--tasks 1,2,3] [--timeout 600000]
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

type RunMode = "solo";
type Complexity = "trivial" | "simple" | "medium" | "complex" | "large";

interface BenchmarkTask {
  id: string;
  name: string;
  goal: string;
  complexity: Complexity;
  requirementKeywords: string[];
}

interface BenchmarkConfig {
  suites: string[];
  tasks: number[];
  modes: RunMode[];
  timeoutMs: number;
}

interface RunResult {
  taskId: string;
  mode: RunMode;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  tokensIn: number;
  tokensOut: number;
  filesCreated: number;
  totalLoc: number;
  workdir: string;
}

interface QualityScore {
  taskId: string;
  mode: RunMode;
  syntaxValid: boolean;
  tscErrors: number;
  filesCreated: number;
  totalLines: number;
  hasTypes: boolean;
  hasErrorHandling: boolean;
  hasExports: boolean;
  requirementsCovered: number;
  securityIssues: number;
  score: number;
}

// ── Task Definitions ───────────────────────────────────────────────────────

const TASKS: BenchmarkTask[] = [
  {
    id: "email-validator",
    name: "Email Validator",
    goal: "Create a TypeScript function that validates email addresses using regex, handles edge cases, export as validateEmail()",
    complexity: "trivial",
    requirementKeywords: ["validate", "email", "regex", "export"],
  },
  {
    id: "rate-limiter",
    name: "Rate Limiter",
    goal: "Create a token bucket rate limiter in TypeScript. Configurable capacity and refill rate, check-and-consume method, reset. Single file, well-typed, no external deps.",
    complexity: "simple",
    requirementKeywords: ["token", "bucket", "capacity", "refill", "consume", "reset"],
  },
  {
    id: "rest-api",
    name: "REST API",
    goal: "Build an Express.js REST API with GET/POST/DELETE /todos, Zod input validation, in-memory storage, error handling middleware, health endpoint. TypeScript, no database.",
    complexity: "medium",
    requirementKeywords: ["express", "get", "post", "delete", "zod", "health", "middleware"],
  },
  {
    id: "jwt-auth",
    name: "JWT Auth",
    goal: "Build a JWT authentication system for Express. Verify tokens, extract user, handle expired tokens, refresh endpoint, bcrypt passwords, Zod validation. TypeScript.",
    complexity: "complex",
    requirementKeywords: ["jwt", "verify", "refresh", "bcrypt", "middleware", "zod"],
  },
  {
    id: "cli-task-manager",
    name: "CLI Task Manager",
    goal: "Build a CLI task manager: add/list/complete/delete tasks, priority levels, due dates, filter by status/priority, JSON file persistence, colored output. TypeScript, only chalk as external dep.",
    complexity: "large",
    requirementKeywords: ["add", "list", "complete", "delete", "priority", "due", "filter", "json", "chalk"],
  },
];

const COMPLEXITIES: Complexity[] = ["trivial", "simple", "medium", "complex", "large"];

// ── CLI Parsing ────────────────────────────────────────────────────────────

function parseCliArgs(): BenchmarkConfig {
  const args = process.argv.slice(2);

  const getArg = (flag: string): string | undefined => {
    const eqForm = args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
    if (eqForm) return eqForm;
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const suiteArg = getArg("--suite") ?? "orchestration,quality";
  const suites = suiteArg === "all"
    ? ["orchestration", "quality", "swebench"]
    : suiteArg.split(",").map((s) => s.trim());

  const tasksArg = getArg("--tasks");
  const tasks = tasksArg
    ? tasksArg.split(",").map((t) => parseInt(t.trim(), 10))
    : [1, 2, 3, 4, 5];

  const modes: RunMode[] = ["solo"];

  const timeoutMs = parseInt(getArg("--timeout") ?? "600000", 10);

  return { suites, tasks, modes, timeoutMs };
}

// ── Subprocess Runner ──────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(join(import.meta.dirname, "..", ".."));
const BENCH_BASE = join(homedir(), "personal", "openpawl-test-projects", "bench");
const REPORT_PATH = join(homedir(), ".openpawl", "benchmark-report.md");
const BENCHMARK_LOG_PATH =
  process.env.OPENPAWL_BENCH_LOG ??
  join(PROJECT_ROOT, "benchmarks", "benchmark-parent.jsonl");
const DELAY_BETWEEN_RUNS_MS = 5_000;

/** Solo kill timeout. The global --timeout flag still acts as the hard upper bound. */
function killTimeoutFor(_mode: RunMode, fallbackMs: number): number {
  return Math.min(fallbackMs, 10 * 60_000);
}

function appendParentLog(entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(PROJECT_ROOT, "benchmarks"), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    appendFileSync(BENCHMARK_LOG_PATH, line + "\n");
  } catch {
    // benchmark log is best-effort; never crash the run
  }
}

function runHeadlessSubprocess(
  goal: string,
  mode: RunMode,
  workdir: string,
  timeoutMs: number,
  taskId?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolve) => {
    mkdirSync(workdir, { recursive: true });

    const effectiveTimeoutMs = killTimeoutFor(mode, timeoutMs);

    // Use bun + built dist/cli.js — tsx+src/cli.ts fails due to .js imports
    const bunPath = join(homedir(), ".bun", "bin", "bun");
    const child: ChildProcess = spawn(
      bunPath,
      [
        join(PROJECT_ROOT, "dist", "cli.js"),
        "run",
        "--headless",
        "--goal", goal,
        "--mode", mode,
        "--workdir", workdir,
      ],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          OPENPAWL_DEBUG: "true",
          OPENPAWL_PROFILE: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    appendParentLog({
      event: "run:start",
      task: taskId,
      mode,
      pid: child.pid,
      killTimeoutMs: effectiveTimeoutMs,
      workdir,
    });

    let stdout = "";
    let stderr = "";
    const start = Date.now();

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      appendParentLog({
        event: "run:pre_kill",
        task: taskId,
        mode,
        pid: child.pid,
        elapsedMs: Date.now() - start,
        reason: "parent_timeout",
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          appendParentLog({
            event: "run:sigkill",
            task: taskId,
            mode,
            pid: child.pid,
            elapsedMs: Date.now() - start,
          });
          child.kill("SIGKILL");
        }
      }, 2_000);
    }, effectiveTimeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      appendParentLog({
        event: "run:close",
        task: taskId,
        mode,
        pid: child.pid,
        exitCode: code ?? -1,
        durationMs,
      });
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      appendParentLog({
        event: "run:error",
        task: taskId,
        mode,
        pid: child.pid,
        error: err.message,
        durationMs,
      });
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + err.message,
        durationMs,
      });
    });
  });
}

// ── Output Parsers ─────────────────────────────────────────────────────────

function parseSoloOutput(stdout: string): { tokensIn: number; tokensOut: number } {
  const m = /Tokens:\s*(\d+)in\/(\d+)out/.exec(stdout);
  if (!m) return { tokensIn: 0, tokensOut: 0 };
  return {
    tokensIn: parseInt(m[1]!, 10),
    tokensOut: parseInt(m[2]!, 10),
  };
}

// ── Workdir Scanner ────────────────────────────────────────────────────────

function collectFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const rel = join(base, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectFiles(full, rel));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry) && entry !== "CONTEXT.md") {
      results.push(full);
    }
  }
  return results;
}

function scanWorkdir(workdir: string): { filesCreated: number; totalLoc: number; sourceFiles: string[] } {
  const sourceFiles = collectFiles(workdir, "");
  let totalLoc = 0;
  for (const f of sourceFiles) {
    totalLoc += readFileSync(f, "utf-8").split("\n").length;
  }
  return { filesCreated: sourceFiles.length, totalLoc, sourceFiles };
}

// ── Suite 1: Orchestration ─────────────────────────────────────────────────

async function runOrchestrationSuite(config: BenchmarkConfig): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const selectedTasks = config.tasks.map((i) => TASKS[i - 1]!);
  const totalRuns = selectedTasks.length * config.modes.length;
  let runIndex = 0;

  for (const task of selectedTasks) {
    for (const mode of config.modes) {
      runIndex++;
      const workdir = join(BENCH_BASE, `${task.id}-${mode}`);
      log(`\n  [${runIndex}/${totalRuns}] ${task.name} in ${mode} mode...`);

      const { exitCode, stdout, stderr, durationMs } = await runHeadlessSubprocess(
        task.goal,
        mode,
        workdir,
        config.timeoutMs,
        task.id,
      );

      // Parse metrics from stdout
      const { tokensIn, tokensOut } = parseSoloOutput(stdout);

      // Scan output files
      const { filesCreated, totalLoc } = scanWorkdir(workdir);

      const result: RunResult = {
        taskId: task.id,
        mode,
        durationMs,
        exitCode,
        stdout,
        stderr,
        tokensIn,
        tokensOut,
        filesCreated,
        totalLoc,
        workdir,
      };
      results.push(result);

      // Log summary
      const status = exitCode === 0 ? "OK" : `EXIT ${exitCode}`;
      const dur = formatMs(durationMs);
      const tokenStr = formatTokens(tokensIn, tokensOut);
      log(`    ${status} | ${dur} | ${filesCreated} files | ${totalLoc} LOC | ${tokenStr}`);

      // Pause between runs
      if (runIndex < totalRuns) {
        await sleep(DELAY_BETWEEN_RUNS_MS);
      }
    }
  }

  return results;
}

// ── Suite 2: Quality ───────────────────────────────────────────────────────

function runQualitySuite(orchestrationResults: RunResult[]): QualityScore[] {
  const scores: QualityScore[] = [];

  for (const run of orchestrationResults) {
    const task = TASKS.find((t) => t.id === run.taskId)!;
    const { sourceFiles } = scanWorkdir(run.workdir);

    // Read all source content
    let allSource = "";
    for (const f of sourceFiles) {
      allSource += readFileSync(f, "utf-8") + "\n";
    }
    const allSourceLower = allSource.toLowerCase();

    // 1. tsc check
    let tscErrors = -1; // -1 = skipped
    if (sourceFiles.length > 0) {
      const tscResult = spawnSync(
        "npx",
        ["tsc", "--noEmit", "--allowJs", "--strict", "--esModuleInterop", "--skipLibCheck", "--moduleResolution", "node", "--target", "es2022", "--module", "es2022", ...sourceFiles],
        { cwd: run.workdir, timeout: 30_000, encoding: "utf-8" },
      );
      if (tscResult.status !== null) {
        const errorLines = (tscResult.stdout || "").split("\n").filter((l) => /error TS\d+/.test(l));
        tscErrors = errorLines.length;
      }
    }

    // 2. `any` usage
    const anyMatches = allSource.match(/:\s*any\b/g) ?? [];
    const asAnyMatches = allSource.match(/as\s+any\b/g) ?? [];
    const anyCount = anyMatches.length + asAnyMatches.length;

    // 3. Error handling
    const hasErrorHandling = /\b(try|catch)\b|\.catch\(|throw\s/.test(allSource);

    // 4. Exports
    const hasExports = /\bexport\b/.test(allSource);

    // 5. Requirements coverage
    let matched = 0;
    for (const kw of task.requirementKeywords) {
      if (allSourceLower.includes(kw.toLowerCase())) matched++;
    }
    const coverage = task.requirementKeywords.length > 0
      ? matched / task.requirementKeywords.length
      : 0;

    // 6. Security issues
    let securityIssues = 0;
    if (/eval\s*\(/.test(allSource)) securityIssues++;
    if (/password\s*[:=]\s*["'][^"']+["']/.test(allSource)) securityIssues++;
    if (/secret\s*[:=]\s*["'][^"']+["']/.test(allSource)) securityIssues++;

    // Compute score (0-10)
    let score = 0;
    const syntaxValid = tscErrors === 0;
    if (tscErrors === 0) score += 3;
    else if (tscErrors > 0 && tscErrors <= 5) score += 2;
    else if (tscErrors > 5 && tscErrors <= 20) score += 1;
    if (anyCount === 0) score += 1;
    if (hasErrorHandling) score += 1;
    if (hasExports) score += 1;
    score += Math.round(coverage * 4);

    scores.push({
      taskId: run.taskId,
      mode: run.mode,
      syntaxValid,
      tscErrors,
      filesCreated: run.filesCreated,
      totalLines: run.totalLoc,
      hasTypes: anyCount === 0,
      hasErrorHandling,
      hasExports,
      requirementsCovered: coverage,
      securityIssues,
      score,
    });
  }

  return scores;
}

// ── Suite 3: SWE-bench (stub) ──────────────────────────────────────────────

interface SweBenchTask {
  id: string;
  repo: string;
  baseCommit: string;
  issueDescription: string;
  difficulty: "easy" | "medium" | "hard";
}

interface SweBenchResult {
  taskId: string;
  mode: RunMode;
  patchApplied: boolean;
  durationMs: number;
  filesChanged: number;
}

const SWE_BENCH_TASKS: SweBenchTask[] = [
  // Placeholder tasks — replace with real SWE-bench Verified IDs when available
  {
    id: "swe-easy-1",
    repo: "pallets/flask",
    baseCommit: "",
    issueDescription: "Fix: Flask.make_response should handle bytes return type correctly",
    difficulty: "easy",
  },
  {
    id: "swe-easy-2",
    repo: "pallets/flask",
    baseCommit: "",
    issueDescription: "Fix: url_for should not raise BuildError when SERVER_NAME includes port",
    difficulty: "easy",
  },
  {
    id: "swe-medium-1",
    repo: "django/django",
    baseCommit: "",
    issueDescription: "Fix: QuerySet.values_list flat=True should work with F expressions",
    difficulty: "medium",
  },
  {
    id: "swe-medium-2",
    repo: "django/django",
    baseCommit: "",
    issueDescription: "Fix: Admin changelist search should handle multi-word queries correctly",
    difficulty: "medium",
  },
  {
    id: "swe-hard-1",
    repo: "django/django",
    baseCommit: "",
    issueDescription: "Fix: Prefetch related with sliced querysets should not duplicate results",
    difficulty: "hard",
  },
];

async function runSweBenchSuite(config: BenchmarkConfig): Promise<SweBenchResult[]> {
  log("\n  SWE-bench suite requires real SWE-bench task IDs and base commits.");
  log("  Skipping — populate SWE_BENCH_TASKS with real data to enable.");
  // TODO: Implement when SWE-bench Verified task IDs are available
  // For each task:
  //   1. git clone <repo> --depth 1 at <baseCommit> into temp dir
  //   2. Run headless solo with issueDescription as goal
  //   3. Capture git diff, check if patch was applied
  //   4. Optionally run swebench eval if installed
  return [];
}

// ── Report Generation ──────────────────────────────────────────────────────

function generateReport(
  config: BenchmarkConfig,
  orchestration: RunResult[],
  quality: QualityScore[],
  sweBench: SweBenchResult[],
): string {
  const now = new Date().toISOString().slice(0, 10);
  let pkgVersion = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as { version?: string };
    pkgVersion = pkg.version ?? "unknown";
  } catch { /* ignore */ }

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w("# OpenPawl Benchmark Report");
  w("");
  w(`Date: ${now}`);
  w(`Version: ${pkgVersion}`);
  w(`Modes: ${config.modes.join(", ")}`);
  w(`Tasks: ${config.tasks.join(", ")}`);
  w("");

  // ── Suite 1: Orchestration Value ──

  if (orchestration.length > 0) {
    w("## Suite 1: Orchestration Value");
    w("");
    w("### Per-Task Results");
    w("");
    w("| Task | Mode | Duration | Files | LOC | Tokens (in/out) | Exit |");
    w("|------|------|----------|-------|-----|----------------|------|");

    for (const r of orchestration) {
      const task = TASKS.find((t) => t.id === r.taskId)!;
      const dur = formatMs(r.durationMs);
      const tokenStr = formatTokens(r.tokensIn, r.tokensOut);
      const exit = r.exitCode === 0 ? "OK" : `${r.exitCode}`;
      w(`| ${task.name} | ${r.mode} | ${dur} | ${r.filesCreated} | ${r.totalLoc} | ${tokenStr} | ${exit} |`);
    }
    w("");

    // Aggregate by mode
    w("### Aggregate by Mode");
    w("");
    w("| Metric | " + config.modes.map((m) => m).join(" | ") + " |");
    w("|--------|" + config.modes.map(() => "------").join("|") + "|");

    for (const metric of ["Avg quality score", "Avg duration", "Avg tokens (in)", "Avg tokens (out)", "Avg files", "Avg LOC", "Syntax pass rate"] as const) {
      const cells: string[] = [];
      for (const mode of config.modes) {
        const modeRuns = orchestration.filter((r) => r.mode === mode);
        const modeQuality = quality.filter((q) => q.mode === mode);

        if (modeRuns.length === 0) { cells.push("-"); continue; }

        switch (metric) {
          case "Avg quality score": {
            if (modeQuality.length === 0) { cells.push("-"); break; }
            const avg = modeQuality.reduce((s, q) => s + q.score, 0) / modeQuality.length;
            cells.push(`${avg.toFixed(1)}/10`);
            break;
          }
          case "Avg duration": {
            const avg = modeRuns.reduce((s, r) => s + r.durationMs, 0) / modeRuns.length;
            cells.push(formatMs(avg));
            break;
          }
          case "Avg tokens (in)": {
            const avg = modeRuns.reduce((s, r) => s + r.tokensIn, 0) / modeRuns.length;
            cells.push(formatK(avg));
            break;
          }
          case "Avg tokens (out)": {
            const avg = modeRuns.reduce((s, r) => s + r.tokensOut, 0) / modeRuns.length;
            cells.push(formatK(avg));
            break;
          }
          case "Avg files": {
            const avg = modeRuns.reduce((s, r) => s + r.filesCreated, 0) / modeRuns.length;
            cells.push(avg.toFixed(1));
            break;
          }
          case "Avg LOC": {
            const avg = modeRuns.reduce((s, r) => s + r.totalLoc, 0) / modeRuns.length;
            cells.push(Math.round(avg).toString());
            break;
          }
          case "Syntax pass rate": {
            if (modeQuality.length === 0) { cells.push("-"); break; }
            const passing = modeQuality.filter((q) => q.syntaxValid).length;
            cells.push(`${passing}/${modeQuality.length}`);
            break;
          }
        }
      }
      w(`| ${metric} | ${cells.join(" | ")} |`);
    }
    w("");

    // Key findings — solo-mode quality summary by complexity
    w("### Key Findings");
    w("");

    for (const c of COMPLEXITIES) {
      const task = TASKS.find((t) => t.complexity === c);
      if (!task) continue;
      const taskQuality = quality.filter((q) => q.taskId === task.id);
      if (taskQuality.length === 0) continue;
      const best = taskQuality.reduce((a, b) => a.score > b.score ? a : b);
      w(`- ${c} tasks (${task.name}): score = **${best.score}/10**`);
    }
    w("");
  }

  // ── Suite 2: Quality Details ──

  if (quality.length > 0) {
    w("## Suite 2: Quality Details");
    w("");
    w("| Task | Mode | Syntax | tsc Errors | Types | Error Handling | Exports | Req Coverage | Security | Score |");
    w("|------|------|--------|-----------|-------|---------------|---------|-------------|----------|-------|");

    for (const q of quality) {
      const task = TASKS.find((t) => t.id === q.taskId)!;
      const syntax = q.tscErrors === -1 ? "skip" : q.syntaxValid ? "pass" : "fail";
      const tscErr = q.tscErrors === -1 ? "-" : String(q.tscErrors);
      const types = q.hasTypes ? "clean" : "has any";
      const errH = q.hasErrorHandling ? "yes" : "no";
      const exports = q.hasExports ? "yes" : "no";
      const cov = `${Math.round(q.requirementsCovered * 100)}%`;
      const sec = q.securityIssues > 0 ? `${q.securityIssues} issues` : "clean";
      w(`| ${task.name} | ${q.mode} | ${syntax} | ${tscErr} | ${types} | ${errH} | ${exports} | ${cov} | ${sec} | ${q.score}/10 |`);
    }
    w("");
  }

  // ── Suite 3: SWE-bench ──

  if (sweBench.length > 0) {
    w("## Suite 3: SWE-bench");
    w("");
    w("| Task ID | Mode | Patch Applied | Files Changed | Duration |");
    w("|---------|------|--------------|--------------|----------|");
    for (const r of sweBench) {
      w(`| ${r.taskId} | ${r.mode} | ${r.patchApplied ? "yes" : "no"} | ${r.filesChanged} | ${formatMs(r.durationMs)} |`);
    }
    w("");
  }

  // ── Recommendations ──

  w("## Recommendations");
  w("");

  if (quality.length > 0) {
    const soloScores = quality.filter((q) => q.mode === "solo");
    const avg = (arr: QualityScore[]) => arr.length > 0 ? arr.reduce((s, q) => s + q.score, 0) / arr.length : 0;
    const soloAvg = avg(soloScores);

    w(`Solo quality summary: avg ${soloAvg.toFixed(1)}/10 across ${soloScores.length} runs`);
  } else {
    w("- Run quality suite for recommendations");
  }

  w("");
  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(msg); }

/** Format a number as "1.2k" for thousands or raw for small values. */
function formatK(n: number): string {
  if (n === 0) return "-";
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

/** Format token pair as "1.2k in / 480 out" or "-" if both zero. */
function formatTokens(tokensIn: number, tokensOut: number): string {
  if (tokensIn === 0 && tokensOut === 0) return "-";
  return `${formatK(tokensIn)} in / ${formatK(tokensOut)} out`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseCliArgs();

  log("=== OpenPawl Orchestration Benchmark ===");
  log(`Suites: ${config.suites.join(", ")}`);
  log(`Tasks: ${config.tasks.join(", ")} (${config.tasks.length} tasks)`);
  log(`Modes: ${config.modes.join(", ")}`);
  log(`Timeout: ${formatMs(config.timeoutMs)} per run`);
  log(`Delay: ${formatMs(DELAY_BETWEEN_RUNS_MS)} between runs`);
  log(`Output dir: ${BENCH_BASE}`);
  log(`Report: ${REPORT_PATH}`);

  mkdirSync(BENCH_BASE, { recursive: true });
  mkdirSync(join(homedir(), ".openpawl"), { recursive: true });

  const totalRuns = config.tasks.length * config.modes.length;
  const estMinutes = Math.ceil(totalRuns * 5);
  log(`\nEstimated: ${totalRuns} runs (~${estMinutes} min at ~5 min avg)`);

  let orchestrationResults: RunResult[] = [];
  let qualityResults: QualityScore[] = [];
  let sweBenchResults: SweBenchResult[] = [];

  const totalStart = Date.now();

  // Suite 1: Orchestration
  if (config.suites.includes("orchestration")) {
    log("\n== Suite 1: Orchestration Value ==");
    orchestrationResults = await runOrchestrationSuite(config);
  }

  // Suite 2: Quality (depends on orchestration results)
  if (config.suites.includes("quality")) {
    log("\n== Suite 2: Quality Checks ==");
    if (orchestrationResults.length === 0) {
      log("  No orchestration results — checking existing workdirs...");
      // Build results from existing workdirs if orchestration wasn't run
      for (const taskIdx of config.tasks) {
        const task = TASKS[taskIdx - 1]!;
        for (const mode of config.modes) {
          const workdir = join(BENCH_BASE, `${task.id}-${mode}`);
          if (existsSync(workdir)) {
            const { filesCreated, totalLoc } = scanWorkdir(workdir);
            orchestrationResults.push({
              taskId: task.id,
              mode,
              durationMs: 0,
              exitCode: 0,
              stdout: "",
              stderr: "",
              tokensIn: 0,
              tokensOut: 0,
              filesCreated,
              totalLoc,
              workdir,
            });
          }
        }
      }
    }
    qualityResults = runQualitySuite(orchestrationResults);
    log(`  Scored ${qualityResults.length} runs`);
    for (const q of qualityResults) {
      const task = TASKS.find((t) => t.id === q.taskId)!;
      log(`    ${task.name} (${q.mode}): ${q.score}/10`);
    }
  }

  // Suite 3: SWE-bench
  if (config.suites.includes("swebench")) {
    log("\n== Suite 3: SWE-bench ==");
    sweBenchResults = await runSweBenchSuite(config);
  }

  const totalDuration = Date.now() - totalStart;

  // Generate and write report
  const report = generateReport(config, orchestrationResults, qualityResults, sweBenchResults);
  writeFileSync(REPORT_PATH, report);

  log(`\n=== Benchmark Complete ===`);
  log(`Total time: ${formatMs(totalDuration)}`);
  log(`Report: ${REPORT_PATH}`);
  log(`Workdirs: ${BENCH_BASE}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
