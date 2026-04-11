/**
 * `openpawl demo` — Terminal showcase of all OpenPawl features.
 * All output is hardcoded synthetic data — zero API calls, zero side effects.
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { logger } from "../core/logger.js";

const SEP = "━".repeat(49);

type StepFn = () => void;

interface DemoStep {
  name: string;
  fn: StepFn;
}

function dim(s: string): string { return pc.dim(s); }
function cyan(s: string): string { return pc.cyan(s); }
function green(s: string): string { return pc.green(s); }
function yellow(s: string): string { return pc.yellow(s); }
function blue(s: string): string { return pc.blue(s); }
function red(s: string): string { return pc.red(s); }
function bold(s: string): string { return pc.bold(s); }
function magenta(s: string): string { return pc.magenta(s); }

function out(s: string): void { logger.plain(s); }

function todayFormatted(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ─── Step 1: Session Briefing ──────────────────────────────────────────

function stepBriefing(): void {
  out(dim(SEP));
  out(cyan("Previously on OpenPawl"));
  out(dim("Last session: yesterday (a3f8b2c1d9e04f71)"));
  out(dim(SEP));
  out(bold("What was built:"));
  out(green("→ WebSocket event schema for real-time quiz sync"));
  out(green("→ Quiz room creation and player join API"));
  out(green("→ Leaderboard ranking service with live updates"));
  out(bold("What the team learned:"));
  out(blue("→ Event-driven arch outperforms polling for live scores"));
  out(blue("→ Connection pooling reduces latency by 40%"));
  out(bold("Left open:"));
  out(yellow('→ "React leaderboard animations" — rework needed'));
  out(dim(SEP));
}

// ─── Step 2: Goal Clarity ──────────────────────────────────────────────

function stepClarity(): void {
  out(dim(SEP));
  out(cyan("Goal Clarity Check"));
  out(dim(SEP));
  out(`  Goal: ${bold('"Add real-time multiplayer support"')}`);
  out("");
  out(yellow("  Challenges found:"));
  out(yellow('  → "Add" is vague — does this mean new feature or extend existing?'));
  out(yellow('  → No success criteria — how do we know it\'s done?'));
  out(yellow('  → "real-time" needs definition — latency target?'));
  out("");
  out(green("  Suggested rewrite:"));
  out(green('  → "Implement WebSocket-based multiplayer with <200ms'));
  out(green('     latency, supporting 4-player rooms with live'));
  out(green('     leaderboard updates"'));
  out(dim(SEP));
}

// ─── Step 3: Drift Detection ───────────────────────────────────────────

function stepDrift(): void {
  out(dim(SEP));
  out(cyan("Drift Detection"));
  out(dim(SEP));
  out(`  New goal: ${bold('"Switch to REST polling for leaderboard"')}`);
  out("");
  out(red("  Conflict detected:"));
  out(red("  → Decision #47 (Mar 15): \"Use WebSocket for all real-time"));
  out(red("    features\" — recommended by coordinator, confidence 0.92"));
  out(red("  → Decision #51 (Mar 16): \"Event-driven architecture for"));
  out(red("    leaderboard\" — recommended by tech-lead, confidence 0.88"));
  out("");
  out(yellow("  Switching to REST polling contradicts 2 active decisions."));
  out(yellow("  Use `openpawl journal show 47` to review reasoning."));
  out(dim(SEP));
}

// ─── Step 4: Goal Decomposition ────────────────────────────────────────

function stepDecomposition(): void {
  out(dim(SEP));
  out(cyan("Sprint Planning — Task Decomposition"));
  out(dim(SEP));
  out(bold("  Goal: \"Build multiplayer quiz game with real-time leaderboard\""));
  out(dim("  Team: architect-1, backend-1, frontend-1"));
  out("");
  out(bold("  Tasks:"));
  out(`  ${green("1.")} Design WebSocket event schema          ${dim("→ architect-1  HIGH")}`);
  out(`  ${green("2.")} Implement quiz room + player join API   ${dim("→ backend-1   HIGH")}`);
  out(`  ${green("3.")} Build leaderboard ranking service       ${dim("→ backend-1   MED")}`);
  out(`  ${green("4.")} Create React leaderboard component      ${dim("→ frontend-1  MED")}`);
  out(`  ${green("5.")} Integrate quiz timer + answer UI        ${dim("→ frontend-1  LOW")}`);
  out("");
  out(dim("  Estimated cost: $0.12  |  5 tasks  |  3 agents"));
  out(dim(SEP));
}

// ─── Step 5: Parallel Execution ────────────────────────────────────────

function stepExecution(): void {
  out(dim(SEP));
  out(cyan("Parallel Execution (Send API)"));
  out(dim(SEP));

  const tasks = [
    { id: 1, desc: "WebSocket event schema",       agent: "architect-1", conf: 0.92, status: "completed" },
    { id: 2, desc: "Quiz room + player join API",   agent: "backend-1",  conf: 0.88, status: "completed" },
    { id: 3, desc: "Leaderboard ranking service",   agent: "backend-1",  conf: 0.85, status: "completed" },
    { id: 4, desc: "React leaderboard component",   agent: "frontend-1", conf: 0.35, status: "failed"    },
    { id: 5, desc: "Quiz timer + answer UI",        agent: "frontend-1", conf: 0.91, status: "completed" },
  ];

  for (const t of tasks) {
    const confStr = (t.conf * 100).toFixed(0) + "%";
    const icon = t.status === "completed" ? green(ICONS.success) : red(ICONS.error);
    const confColor = t.conf > 0.7 ? green(confStr) : red(confStr);
    out(`  ${icon} Task ${t.id}: ${t.desc}`);
    out(`    ${dim(t.agent)}  confidence: ${confColor}`);
  }

  out("");
  out(`  ${green("4 passed")}  ${red("1 failed")}  avg confidence: ${yellow("78%")}`);
  out(dim(SEP));
}

// ─── Step 6: Partial Approval ──────────────────────────────────────────

function stepApproval(): void {
  out(dim(SEP));
  out(cyan("Partial Approval"));
  out(dim(SEP));
  out(bold("  4 tasks auto-approved (confidence > 0.7)"));
  out("");
  out(red("  Task 4 flagged for rework:"));
  out(red('  → "React leaderboard component" — confidence 35%'));
  out(red("  → Reason: animation performance below threshold"));
  out(red("  → Action: rerouted to QA loop, retry #1"));
  out("");
  out(green("  After rework:"));
  out(green("  → Task 4 re-executed — confidence 0.82 — approved"));
  out(dim(SEP));
}

// ─── Step 7: Team Learning ─────────────────────────────────────────────

function stepLearning(): void {
  out(dim(SEP));
  out(cyan("Post-Mortem & Learning"));
  out(dim(SEP));
  out(bold("  Lessons extracted from this session:"));
  out(blue("  → Event-driven architecture outperforms polling for scores"));
  out(blue("  → CSS animations need requestAnimationFrame for 60fps"));
  out(blue("  → Connection pooling reduces WebSocket latency by 40%"));
  out("");
  out(bold("  Promoted to global memory:"));
  out(green("  → \"Use requestAnimationFrame for leaderboard animations\""));
  out(green("  → Confidence: 0.91 — will be retrieved in future sessions"));
  out("");
  out(dim("  Global patterns: 47 total  |  3 new this session"));
  out(dim(SEP));
}

// ─── Step 8: Standup ───────────────────────────────────────────────────

function stepStandup(): void {
  const today = todayFormatted();
  out(dim(SEP));
  out(cyan(`Standup — ${today}`));
  out(dim(SEP));
  out(bold("Yesterday:"));
  out(green("  → Build multiplayer quiz game — 5 tasks (1 rework)"));
  out(green("  → Total cost: $0.12"));
  out(dim(SEP));
  out(bold("Blocked:"));
  out(yellow("  🔴 React leaderboard animations need perf review"));
  out(yellow("  🟡 frontend-1 score 0.45, trend degrading"));
  out(dim(SEP));
  out(bold("Suggested:"));
  out(blue("  → Review frontend-1 task routing — confidence dropping"));
  out(blue("  → Pick up deferred: mobile responsive layout"));
  out(dim(SEP));
  out(dim("🔥 3-day streak  •  💰 $0.34 this week  •  🧠 47 patterns"));
  out(dim(SEP));
}

// ─── Step 9: Rubber Duck ───────────────────────────────────────────────

function stepThink(): void {
  out(dim(SEP));
  out(cyan("Rubber Duck Mode — openpawl think"));
  out(dim(`Question: "Should we use SSE or WebSocket for the dashboard?"`));
  out(dim(SEP));
  out(bold("  Tech Lead perspective:"));
  out(`  SSE is simpler — unidirectional, auto-reconnect, works`);
  out(`  through proxies. Dashboard only needs server→client flow.`);
  out("");
  out(bold("  RFC Author perspective:"));
  out(`  WebSocket enables future bidirectional features like`);
  out(`  live editing and collaborative sessions.`);
  out("");
  out(bold("  Coordinator synthesis:"));
  out(green(`  → Recommendation: Use SSE for v1`));
  out(`  → Confidence: ${green("88%")}`);
  out(`  → Reasoning: Dashboard is read-only today. SSE is simpler,`);
  out(`    more reliable, and sufficient. Switch to WebSocket later`);
  out(`    only if bidirectional features are needed.`);
  out(`  → Tradeoffs:`);
  out(green(`    Pros: Simple, reliable, proxy-friendly`));
  out(yellow(`    Cons: No bidirectional, would need migration later`));
  out(dim(SEP));
}

// ─── Step 10: Template Marketplace ─────────────────────────────────────

function stepTemplates(): void {
  out(dim(SEP));
  out(cyan("Template Marketplace"));
  out(dim("5 templates  |  Built-in, no network needed"));
  out(dim(SEP));

  const templates = [
    { id: "content-creator",         desc: "Research → Script → SEO → Review",     cost: "$0.07", agents: 4 },
    { id: "indie-hacker",            desc: "Architect → Engineer → QA → RFC",      cost: "$0.12", agents: 4 },
    { id: "research-intelligence",   desc: "Research → Verify → Synthesize",       cost: "$0.09", agents: 3 },
    { id: "business-ops",            desc: "Process → Automate → Document",        cost: "$0.08", agents: 3 },
    { id: "full-stack-sprint",       desc: "Frontend → Backend → DevOps → Lead",   cost: "$0.15", agents: 4 },
  ];

  for (const t of templates) {
    const id = green(t.id.padEnd(25));
    out(`  ${id} ${t.desc}`);
    out(`  ${dim(`${t.agents} agents  ~${t.cost}/run`)}`);
  }

  out("");
  out(dim("  openpawl templates install indie-hacker"));
  out(dim('  openpawl work --template indie-hacker --goal "Build auth"'));
  out(dim(SEP));
}

// ─── Step 11: Closing Summary ──────────────────────────────────────────

function stepSummary(): void {
  out(dim(SEP));
  out(cyan("Session Complete"));
  out(dim(SEP));
  out(`  ${bold("Tasks:")}      ${green("5 completed")} (1 after rework)`);
  out(`  ${bold("Cost:")}       $0.12`);
  out(`  ${bold("Confidence:")} ${green("84%")} average`);
  out(`  ${bold("Lessons:")}    3 extracted, 1 promoted to global memory`);
  out(`  ${bold("Decisions:")}  2 logged to journal`);
  out(`  ${bold("Handoff:")}    CONTEXT.md generated`);
  out("");
  out(magenta("  Vibe Score: 78/100 ↑ (+3 from last week)"));
  out("");
  out(dim("  Next steps:"));
  out(dim("    openpawl standup        — check what's blocked"));
  out(dim("    openpawl work           — start next sprint"));
  out(dim("    openpawl journal list   — review decisions"));
  out(dim("    openpawl replay list    — replay this session"));
  out(dim(SEP));
}

// ─── Main ──────────────────────────────────────────────────────────────

const STEPS: DemoStep[] = [
  { name: "Session Briefing",      fn: stepBriefing },
  { name: "Goal Clarity Check",    fn: stepClarity },
  { name: "Drift Detection",       fn: stepDrift },
  { name: "Goal Decomposition",    fn: stepDecomposition },
  { name: "Parallel Execution",    fn: stepExecution },
  { name: "Partial Approval",      fn: stepApproval },
  { name: "Team Learning",         fn: stepLearning },
  { name: "Standup",               fn: stepStandup },
  { name: "Rubber Duck Mode",      fn: stepThink },
  { name: "Template Marketplace",  fn: stepTemplates },
  { name: "Closing Summary",       fn: stepSummary },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runDemo(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    logger.plain([
      pc.bold("openpawl demo") + " — Showcase all OpenPawl features",
      "",
      "Usage:",
      "  openpawl demo                Run full 11-step demo",
      "  openpawl demo --fast         Skip pauses between steps",
      "  openpawl demo --step 4       Run only step N (1-11)",
      "",
      "Steps:",
      ...STEPS.map((s, i) => `  ${String(i + 1).padStart(2)}. ${s.name}`),
    ].join("\n"));
    return;
  }

  const fast = args.includes("--fast");
  const stepIdx = args.indexOf("--step");
  const singleStep = stepIdx >= 0 ? parseInt(args[stepIdx + 1] ?? "", 10) : null;

  if (singleStep != null) {
    if (singleStep < 1 || singleStep > STEPS.length || isNaN(singleStep)) {
      logger.plain(red(`Invalid step: ${args[stepIdx + 1]}. Must be 1-${STEPS.length}.`));
      return;
    }
    const step = STEPS[singleStep - 1]!;
    out("");
    out(bold(dim(`  Step ${singleStep}/${STEPS.length}: ${step.name}`)));
    out("");
    step.fn();
    out("");
    return;
  }

  // Full demo
  const pauseMs = fast ? 0 : 400;

  out("");
  out(dim(SEP));
  out(bold(cyan("  OpenPawl Demo — 11 Features in Action")));
  out(dim("  All output is synthetic. No API calls. No side effects."));
  out(dim(SEP));

  for (let i = 0; i < STEPS.length; i++) {
    if (pauseMs > 0) await sleep(pauseMs);
    out("");
    out(bold(dim(`  Step ${i + 1}/${STEPS.length}: ${STEPS[i]!.name}`)));
    out("");
    STEPS[i]!.fn();
  }

  out("");
}
