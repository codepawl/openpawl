#!/usr/bin/env tsx
/**
 * Prompt Quality Test — runs each agent role through real LLM calls
 * with a realistic goal, saves outputs for human review.
 *
 * Usage: node --use-env-proxy node_modules/.bin/tsx src/testing/prompt-quality-test.ts
 *    or: HTTPS_PROXY= node node_modules/.bin/tsx src/testing/prompt-quality-test.ts  (no proxy)
 */

import { spawnSync } from "node:child_process";

// ── Auto re-exec with --use-env-proxy for corporate proxies ─────────
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  || process.env.https_proxy || process.env.http_proxy;
if (proxyUrl && !process.execArgv.includes("--use-env-proxy")) {
  const [major] = process.versions.node.split(".").map(Number) as [number];
  if (major >= 22) {
    console.log(`Proxy detected (${proxyUrl}). Re-launching with --use-env-proxy...`);
    // Re-exec with full original argv so tsx loader stays active
    const result = spawnSync(
      process.execPath,
      ["--use-env-proxy", "--no-warnings=ExperimentalWarning", ...process.execArgv, ...process.argv.slice(1)],
      { stdio: "inherit", env: process.env },
    );
    process.exit(result.status ?? 1);
  }
}

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isProfilingEnabled, profileStart, generateReport as generateProfileReport } from "../telemetry/profiler.js";

// ── Test configuration ──────────────────────────────────────────────

const TEST_GOAL = `Build a REST API with JWT authentication, rate limiting (100 req/min per user), and a /health endpoint. Use Express.js and PostgreSQL. Include input validation with Zod.`;

const VAGUE_GOAL = "make it better";

const CONTRADICTORY_ARCHITECTURE = `
## Architecture
- Framework: Express.js
- Database: MongoDB with Mongoose ORM
- Auth: Session-based with cookies
- No rate limiting needed
`.trim();

const OUTPUT_DIR = join(homedir(), ".openpawl", "prompt-test");

// ── Types ───────────────────────────────────────────────────────────

interface AgentTestResult {
  agent: string;
  role: string;
  input: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

// ── LLM call wrapper ────────────────────────────────────────────────

const DELAY_BETWEEN_CALLS_MS = 2000;
const RETRY_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastCallTime = 0;

async function callAgent(
  agentId: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; usage: { input: number; output: number }; durationMs: number }> {
  // Dynamic import to avoid loading providers at module level
  const { callLLM } = await import("../engine/llm.js");

  // Rate limit: wait between sequential calls
  const elapsed = Date.now() - lastCallTime;
  if (lastCallTime > 0 && elapsed < DELAY_BETWEEN_CALLS_MS) {
    await sleep(DELAY_BETWEEN_CALLS_MS - elapsed);
  }

  const attempt = async () => {
    const start = Date.now();
    const response = await callLLM(userPrompt, {
      systemPrompt,
      onChunk: () => process.stdout.write("."),
    });
    lastCallTime = Date.now();
    return {
      text: response.text,
      usage: response.usage,
      durationMs: Date.now() - start,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    // Retry once on connection errors
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(` [retry: ${msg.slice(0, 60)}]`);
    await sleep(RETRY_DELAY_MS);
    return attempt();
  }
}

// ── Agent system prompts (matching agent-registry.ts) ───────────────

const IDENTITY = `RULES: No emojis. No bullet suggestions. No "Would you like..." questions. Be terse. Stop when done.\nYou are an AI agent in OpenPawl.`;

const AGENT_PROMPTS: Record<string, string> = {
  planner: `${IDENTITY}\n\nBreak goals into concrete steps. Each step: what to do, which files, expected outcome. No philosophy.`,
  coder: `${IDENTITY}\n\nWrite and modify code. Use tools to read files before editing. Output working code, not explanations about code.`,
  reviewer: `${IDENTITY}\n\nReview code. Read the actual files before commenting. Report issues with file:line references. Skip praise.`,
  tester: `${IDENTITY}\n\nWrite test code. Read the source first to understand what to test. Show test code, not test philosophy.`,
  debugger: `${IDENTITY}\n\nDebug by reading the actual error and source code. Trace the root cause. Fix it or explain exactly what's wrong.`,
  researcher: `${IDENTITY}\n\nSearch and fetch information. Return facts, not summaries of your search process.`,
  assistant: `${IDENTITY}\n\nAnswer directly. If a tool would help, use it. If not, give the shortest correct answer.`,
};

// ── Pipeline stages ─────────────────────────────────────────────────

interface PipelineContext {
  goal: string;
  planOutput?: string;
  architectureOutput?: string;
  workerOutputs: string[];
}

async function runPipeline(): Promise<AgentTestResult[]> {
  const results: AgentTestResult[] = [];
  const ctx: PipelineContext = { goal: TEST_GOAL, workerOutputs: [] };

  console.log("\n=== OpenPawl Prompt Quality Test ===\n");
  console.log(`Goal: ${TEST_GOAL.slice(0, 80)}...\n`);

  // 1. Planner — task breakdown with tech constraints and worker-ready detail
  {
    console.log("1/6  planner (task breakdown)");
    const input = `Break this goal into concrete implementation tasks. For each task include: exact file path, what to implement, key function/export names, technology constraints from the goal, and acceptance criteria.\n\n${ctx.goal}`;
    const r = await runAgent("planner", "planner", input);
    results.push(r);
    ctx.planOutput = r.output;
  }

  // 2. Planner — architecture design
  {
    console.log("\n2/6  planner (architecture)");
    const input = `Design the system architecture for this project. Include components, data flow, API endpoints, and technology choices.\n\nGoal: ${ctx.goal}\n\nTask breakdown:\n${ctx.planOutput?.slice(0, 2000) ?? "(none)"}`;
    const r = await runAgent("planner", "architect", input);
    results.push(r);
    ctx.architectureOutput = r.output;
  }

  // 3. Coder — worker task 1 (core API)
  {
    console.log("\n3/6  coder (worker: core API)");
    const input = `Implement the Express.js REST API server with /health endpoint and basic middleware setup.\n\nTech constraints (from goal): Use Express.js. Use TypeScript.\n\nArchitecture context:\n${ctx.architectureOutput?.slice(0, 1500) ?? "(none)"}\n\nWrite the complete code for src/server.ts and src/routes/health.ts.`;
    const r = await runAgent("coder", "worker_1_api", input);
    results.push(r);
    ctx.workerOutputs.push(r.output);
  }

  // 4. Coder — worker task 2 (auth)
  {
    console.log("\n4/6  coder (worker: JWT auth)");
    const input = `Implement JWT authentication middleware and login/register endpoints.\n\nTech constraints (from goal): Use PostgreSQL for user storage (NOT in-memory). Use Zod for input validation. Use bcrypt for password hashing.\n\nArchitecture context:\n${ctx.architectureOutput?.slice(0, 1500) ?? "(none)"}\n\nWrite the complete code for src/middleware/auth.ts and src/routes/auth.ts.`;
    const r = await runAgent("coder", "worker_2_auth", input);
    results.push(r);
    ctx.workerOutputs.push(r.output);
  }

  // 5. Reviewer — review worker output
  {
    console.log("\n5/6  reviewer (code review)");
    const workerCode = ctx.workerOutputs.map((w, i) => `--- Worker ${i + 1} ---\n${w.slice(0, 2000)}`).join("\n\n");
    const input = `Review this code for bugs, security issues, and best practices.\n\nGoal: ${ctx.goal}\n\n${workerCode}`;
    const r = await runAgent("reviewer", "reviewer", input);
    results.push(r);
  }

  // 6. Tester — write tests
  {
    console.log("\n6/6  tester (test plan)");
    const input = `Write tests for this REST API. Cover: health endpoint, JWT auth flow (register, login, protected route), rate limiting, input validation.\n\nArchitecture:\n${ctx.architectureOutput?.slice(0, 1000) ?? "(none)"}\n\nImplementation:\n${ctx.workerOutputs[0]?.slice(0, 1500) ?? "(none)"}`;
    const r = await runAgent("tester", "tester", input);
    results.push(r);
  }

  // ── Failure mode tests ──────────────────────────────────────────

  console.log("\n=== Failure Mode Tests ===\n");

  // Vague goal
  {
    console.log("F1  planner (vague goal)");
    const input = `Break this goal into concrete implementation tasks:\n\n${VAGUE_GOAL}`;
    const r = await runAgent("planner", "failure_vague", input);
    results.push(r);
  }

  // Contradictory context
  {
    console.log("\nF2  coder (contradictory context)");
    const input = `Implement the database layer for this project.\n\nGoal: ${ctx.goal}\n\nArchitecture document:\n${CONTRADICTORY_ARCHITECTURE}\n\nThe goal says PostgreSQL but the architecture says MongoDB. Which should you follow? Implement accordingly.`;
    const r = await runAgent("coder", "failure_contradiction", input);
    results.push(r);
  }

  // Huge context
  {
    console.log("\nF3  coder (huge context)");
    const padding = "// Previous implementation context (large codebase scan results):\n" +
      Array.from({ length: 80 }, (_, i) =>
        `// File: src/modules/module_${i}.ts — Contains ${50 + i} functions for ${["auth", "database", "logging", "config", "routing", "middleware", "validation", "caching"][i % 8]} subsystem. Last modified 2024-01-${String(10 + (i % 20)).padStart(2, "0")}. Dependencies: ${["express", "pg", "jsonwebtoken", "zod", "bcrypt", "helmet"][i % 6]}. Status: production-ready.`
      ).join("\n");
    const input = `${padding}\n\n---\n\nYour specific task: Write ONLY the rate limiting middleware in src/middleware/rate-limit.ts. Use a sliding window algorithm with PostgreSQL for state. 100 requests per minute per user.\n\nDo not summarize the context above. Write the code.`;
    const r = await runAgent("coder", "failure_huge_context", input);
    results.push(r);
  }

  return results;
}

async function runAgent(agentId: string, label: string, input: string): Promise<AgentTestResult> {
  const systemPrompt = AGENT_PROMPTS[agentId] ?? AGENT_PROMPTS.assistant!;
  try {
    const { text, usage, durationMs } = await callAgent(agentId, systemPrompt, input);
    console.log(` done (${usage.input}+${usage.output} tokens, ${(durationMs / 1000).toFixed(1)}s)`);
    return {
      agent: agentId,
      role: label,
      input,
      output: text,
      inputTokens: usage.input,
      outputTokens: usage.output,
      durationMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(` ERROR: ${msg.slice(0, 100)}`);
    return {
      agent: agentId,
      role: label,
      input,
      output: "",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      error: msg,
    };
  }
}

// ── Report generation ───────────────────────────────────────────────

function generateReport(results: AgentTestResult[]): string {
  const mainResults = results.filter((r) => !r.role.startsWith("failure_"));
  const failureResults = results.filter((r) => r.role.startsWith("failure_"));

  const totalIn = results.reduce((s, r) => s + r.inputTokens, 0);
  const totalOut = results.reduce((s, r) => s + r.outputTokens, 0);
  // Rough cost estimate: $3/M input, $15/M output (Claude Sonnet tier)
  const costEst = (totalIn * 3 + totalOut * 15) / 1_000_000;

  const lines: string[] = [
    "# OpenPawl Prompt Quality Report",
    "",
    `Date: ${new Date().toISOString()}`,
    `Goal: ${TEST_GOAL}`,
    "",
    "## Per-Agent Results",
    "",
  ];

  for (const r of mainResults) {
    const preview = r.output.replace(/\n/g, " ").slice(0, 200);
    lines.push(
      `### ${r.role} (${r.agent})`,
      `Tokens in: ${r.inputTokens} | Tokens out: ${r.outputTokens} | Time: ${r.durationMs}ms`,
      `Output preview: ${preview}...`,
      `Relevance: _/5 | Specificity: _/5 | Structure: _/5 | Actionability: _/5`,
      `Notes: `,
      "",
    );
  }

  lines.push("## Failure Mode Tests", "");
  lines.push("| Test | Agent | Expected | Output preview |");
  lines.push("|------|-------|----------|----------------|");
  for (const r of failureResults) {
    const expected = r.role === "failure_vague" ? "reject/clarify"
      : r.role === "failure_contradiction" ? "flag conflict"
      : "stay focused on task";
    const preview = (r.output || r.error || "").replace(/\n/g, " ").slice(0, 80);
    lines.push(`| ${r.role} | ${r.agent} | ${expected} | ${preview} |`);
  }

  lines.push("", "## Token Usage Summary", "");
  lines.push("| Agent | Role | Input tokens | Output tokens | Time | Cost est |");
  lines.push("|-------|------|-------------|--------------|------|----------|");
  for (const r of results) {
    const cost = ((r.inputTokens * 3 + r.outputTokens * 15) / 1_000_000).toFixed(4);
    lines.push(`| ${r.agent} | ${r.role} | ${r.inputTokens} | ${r.outputTokens} | ${(r.durationMs / 1000).toFixed(1)}s | $${cost} |`);
  }
  lines.push(`| **TOTAL** | | **${totalIn}** | **${totalOut}** | | **$${costEst.toFixed(4)}** |`);

  lines.push(
    "",
    "## Bottleneck Candidates",
    "",
    "_Review each agent's output file and fill in which agents produce weak output that hurts downstream quality._",
    "",
  );

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const finishPipeline = profileStart("total_pipeline", "prompt-quality-test");
  const results = await runPipeline();
  finishPipeline();

  // Save individual outputs
  for (const r of results) {
    const filename = `${r.role}.md`;
    const content = [
      `# ${r.role} (${r.agent})`,
      "",
      `## Input`,
      "```",
      r.input,
      "```",
      "",
      `## Output`,
      "",
      r.error ? `**ERROR:** ${r.error}` : r.output,
      "",
      `## Stats`,
      `- Input tokens: ${r.inputTokens}`,
      `- Output tokens: ${r.outputTokens}`,
      `- Duration: ${r.durationMs}ms`,
    ].join("\n");
    writeFileSync(join(OUTPUT_DIR, filename), content);
  }

  // Save summary report
  const report = generateReport(results);
  writeFileSync(join(OUTPUT_DIR, "QUALITY_REPORT.md"), report);

  // Save profiler report if profiling is enabled
  if (isProfilingEnabled()) {
    const profileReport = generateProfileReport();
    const profilePath = join(homedir(), ".openpawl", "profile-report.md");
    writeFileSync(profilePath, profileReport);
    console.log(`\n  Profile report: ${profilePath}`);
  }

  console.log(`\n\n=== Done ===`);
  console.log(`Reports saved to: ${OUTPUT_DIR}/`);
  console.log(`  - QUALITY_REPORT.md (summary)`);
  console.log(`  - <agent>.md (individual outputs)`);
  console.log(`\nReview each .md file and fill in quality scores in QUALITY_REPORT.md`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
