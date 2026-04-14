#!/usr/bin/env bun
/**
 * Screenshot automation — captures terminal screenshots of openpawl in
 * specific states for README and documentation.
 *
 * Uses VirtualTerminal to drive the TUI without a real terminal, then
 * converts ANSI output to SVG with Catppuccin Mocha theme.
 *
 * Usage:
 *   bun run tsx src/testing/screenshot-automation.ts           # all screenshots
 *   bun run tsx src/testing/screenshot-automation.ts welcome   # single screenshot
 *   bun run tsx src/testing/screenshot-automation.ts --list    # list available shots
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { ansiToSvg, type SvgOptions } from "./ansi-to-svg.js";

const COLS = 100;
const ROWS = 30;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../../docs/screenshots");

// ── Helpers ─────────────────────────────────────────────────────────────────

function saveSvg(name: string, svg: string): void {
  const path = join(OUT_DIR, `${name}.svg`);
  writeFileSync(path, svg);
  console.log(`  ${pc.green("\u2713")} ${path}`);
}

const SVG_OPTS: SvgOptions = { columns: COLS, rows: ROWS };

// ── Screenshot definitions ──────────────────────────────────────────────────

interface Screenshot {
  name: string;
  description: string;
  capture: () => Promise<string[]>;
}

// --------------------------------------------------------------------------
// 1. Welcome screen
// --------------------------------------------------------------------------

async function captureWelcome(): Promise<string[]> {
  const { rgb, bold: ansiBold } = await import("../tui/core/ansi.js");
  const ctp = {
    mauve: rgb(0xcb, 0xa6, 0xf7),
    blue: rgb(0x89, 0xb4, 0xfa),
    peach: rgb(0xfa, 0xb3, 0x87),
    overlay0: rgb(0x6c, 0x70, 0x86),
    surface1: rgb(0x45, 0x47, 0x5a),
  };

  const lines = [
    "",
    `       ${ctp.mauve("\u2584\u2584\u2584")}`,
    `      ${ctp.mauve("\u2588\u2588\u2588\u2588")}   ${ansiBold(ctp.mauve("OpenPawl"))}`,
    `       ${ctp.mauve("\u2580\u2580\u2580")}   ${ctp.overlay0("v0.0.1 \u00b7 interactive AI agent TUI")}`,
    "",
    `  ${ctp.surface1("\u2500".repeat(50))}`,
    "",
    `  ${ctp.blue("/help")}           Show commands`,
    `  ${ctp.blue("/settings")}       Configure provider`,
    `  ${ctp.blue("/model")}          Switch model`,
    `  ${ctp.blue("/sprint <goal>")}  Autonomous multi-agent mode`,
    `  ${ctp.blue("/agents")}         List agents`,
    "",
    `  ${ctp.peach("!command")}         Run shell command`,
    `  ${ctp.blue("@file")}            Reference a file`,
    "",
    `  ${ctp.overlay0("Agents:")}`,
    `  ${ctp.blue("@coder")}    Coder        ${ctp.blue("@reviewer")}  Reviewer`,
    `  ${ctp.blue("@planner")}  Planner      ${ctp.blue("@tester")}    Tester`,
    `  ${ctp.blue("@debugger")} Debugger`,
    "",
    `  ${ctp.overlay0("Tip: Just type a message to get started")}`,
    "",
    `  ${ctp.surface1("\u2500".repeat(50))}`,
    `  ${ctp.mauve("\u276f")} ${ctp.overlay0("_")}`,
  ];
  return lines;
}

// --------------------------------------------------------------------------
// 2. Settings view
// --------------------------------------------------------------------------

async function captureSettings(): Promise<string[]> {
  const { rgb, bold: ansiBold } = await import("../tui/core/ansi.js");
  const ctp = {
    mauve: rgb(0xcb, 0xa6, 0xf7),
    overlay0: rgb(0x6c, 0x70, 0x86),
    green: rgb(0xa6, 0xe3, 0xa1),
    blue: rgb(0x89, 0xb4, 0xfa),
  };

  const lines = [
    "  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
    `  \u2502 ${ansiBold(ctp.mauve("\u2699 Settings"))}${" ".repeat(30)}\u2502`,
    "  \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
    `  \u2502   ${ctp.mauve("\u25b8 ")}${ansiBold("Provider")}${" ".repeat(8)}opencode-go ${ctp.green("\u2713")}     \u2502`,
    `  \u2502     Model${" ".repeat(12)}qwen3.5:4b              \u2502`,
    `  \u2502     API Key${" ".repeat(9)}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 ${ctp.green("\u2713")}           \u2502`,
    `  \u2502     Mode${" ".repeat(13)}auto                    \u2502`,
    `  \u2502     Temperature${" ".repeat(6)}0.7                     \u2502`,
    `  \u2502                                                 \u2502`,
    "  \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
    `  \u2502 ${ctp.overlay0("\u2191\u2193 navigate \u00b7 Enter edit \u00b7 Esc close")}              \u2502`,
    "  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
  ];
  return lines;
}

// --------------------------------------------------------------------------
// 3. Model view
// --------------------------------------------------------------------------

async function captureModelView(): Promise<string[]> {
  const { rgb, bold: ansiBold } = await import("../tui/core/ansi.js");
  const ctp = {
    mauve: rgb(0xcb, 0xa6, 0xf7),
    green: rgb(0xa6, 0xe3, 0xa1),
    overlay0: rgb(0x6c, 0x70, 0x86),
    overlay1: rgb(0x7f, 0x84, 0x9c),
    subtext1: rgb(0xba, 0xc2, 0xde),
  };

  const lines = [
    "  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
    `  \u2502 ${ansiBold(ctp.mauve("\u26a1 Models"))}${" ".repeat(32)}\u2502`,
    "  \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
    `  \u2502     ${ctp.green("\u25cf")} ${ctp.subtext1("opencode-go")} ${ctp.green("\u2713 active")}               \u2502`,
    `  \u2502       ${ctp.mauve("\u25b8 ")}${ansiBold("qwen3.5:4b")}  ${ctp.overlay0("4k ctx")}  ${ctp.green("\u2190 current")}  \u2502`,
    `  \u2502         qwen3.5:2b  ${ctp.overlay0("4k ctx")}                  \u2502`,
    `  \u2502                                                 \u2502`,
    `  \u2502     ${ctp.green("\u25cf")} ${ctp.subtext1("ollama")}                              \u2502`,
    `  \u2502         qwen3.5:4b  ${ctp.overlay0("4k ctx")}                  \u2502`,
    `  \u2502         qwen3.5:2b  ${ctp.overlay0("4k ctx")}                  \u2502`,
    `  \u2502                                                 \u2502`,
    `  \u2502     ${ctp.overlay1("+ Add provider...")}                        \u2502`,
    "  \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
    `  \u2502 ${ctp.overlay0("\u2191\u2193 navigate \u00b7 Enter select \u00b7 r refresh \u00b7 Esc")}    \u2502`,
    "  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
  ];
  return lines;
}

// --------------------------------------------------------------------------
// 4. Sprint output (from headless)
// --------------------------------------------------------------------------

async function captureSprintOutput(): Promise<string[]> {
  // Build synthetic sprint output matching actual format
  const lines = [
    "",
    `  ${pc.cyan("[planner]")} planning tasks...`,
    `  ${pc.dim("\u2192")} ${pc.green("5 tasks")} (4.2s)`,
    "",
    `  ${pc.dim("1.")} Initialize Next.js project with TypeScript and Tailwind`,
    `  ${pc.dim("2.")} Create database schema with Prisma ORM`,
    `  ${pc.dim("3.")} Build REST API routes for CRUD operations`,
    `  ${pc.dim("4.")} Create React components for dashboard UI`,
    `  ${pc.dim("5.")} Write integration tests and verify build`,
    "",
    `  ${pc.cyan("[coder]")} Initialize Next.js project with TypeScript and Tailwind`,
    `    ${pc.dim("tool: shell_exec")}${pc.dim(" \u2713")}`,
    `    ${pc.dim("tool: file_write")}${pc.dim(" \u2713")}`,
    `    ${pc.dim("tool: file_write")}${pc.dim(" \u2713")}`,
    `  ${pc.dim("\u2192")} ${pc.green("done")} (18.3s, 1240 tokens)`,
    "",
    `  ${pc.cyan("[coder]")} Create database schema with Prisma ORM`,
    `    ${pc.dim("tool: file_write")}${pc.dim(" \u2713")}`,
    `    ${pc.dim("tool: shell_exec")}${pc.dim(" \u2713")}`,
    `  ${pc.dim("\u2192")} ${pc.green("done")} (12.1s, 890 tokens)`,
    "",
    `  ${pc.cyan("[coder]")} Build REST API routes for CRUD operations`,
    `    ${pc.dim("tool: file_write")}${pc.dim(" \u2713")}`,
    `    ${pc.dim("tool: file_write")}${pc.dim(" \u2713")}`,
    `    ${pc.dim("tool: file_write")}${pc.dim(" \u2713")}`,
    `  ${pc.dim("\u2192")} ${pc.green("done")} (22.5s, 1890 tokens)`,
    "",
    pc.dim("\u2500".repeat(60)),
    `Total: ${pc.bold("1m 42s")}`,
  ];
  return lines;
}

// --------------------------------------------------------------------------
// 5. Status bar detail
// --------------------------------------------------------------------------

async function captureStatusBar(): Promise<string[]> {
  // Build a styled status bar line matching actual format
  const { rgb, bgRgb } = await import("../tui/core/ansi.js");
  const ctp = {
    subtext1: rgb(0xba, 0xc2, 0xde),
    green: rgb(0xa6, 0xe3, 0xa1),
    mauve: rgb(0xcb, 0xa6, 0xf7),
    overlay0: rgb(0x6c, 0x70, 0x86),
    sapphire: rgb(0x74, 0xc7, 0xec),
    peach: rgb(0xfa, 0xb3, 0x87),
    bgMantle: bgRgb(0x18, 0x18, 0x25),
  };

  const segments = [
    ctp.subtext1(`opencode-go \u25c6 qwen3.5:4b`),
    "  ",
    ctp.green(`\u25cf connected`),
    "  ",
    ctp.mauve(`\u25c6 default`),
    "  ",
    ctp.overlay0(`idle`),
    "  ",
    `${ctp.sapphire("1.2k\u2191")} ${ctp.peach("480\u2193")}`,
  ];

  const statusLine = ctp.bgMantle(segments.join(""));
  const rightText = ctp.overlay0("/help");

  // Show just the status bar area
  const lines: string[] = [
    "",
    pc.dim("  Status bar shows provider, connection, mode, agent state, and token usage:"),
    "",
    `  ${statusLine}${"  ".repeat(10)}${rightText}`,
    "",
    pc.dim("  Segments: provider \u00b7 connection \u00b7 mode \u00b7 state \u00b7 tokens"),
    "",
    pc.dim("  Provider + model: ") + ctp.subtext1("opencode-go \u25c6 qwen3.5:4b"),
    pc.dim("  Connection:       ") + ctp.green("\u25cf connected"),
    pc.dim("  Mode:             ") + ctp.overlay0("\u203a solo") + pc.dim("  (Shift+Tab to cycle)"),
    pc.dim("  Agent state:      ") + ctp.overlay0("idle") + pc.dim("  (shows thinking/working/tool name)"),
    pc.dim("  Token usage:      ") + `${ctp.sapphire("1.2k\u2191")} ${ctp.peach("480\u2193")}` + pc.dim("  (input/output)"),
  ];
  return lines;
}

// --------------------------------------------------------------------------
// 6. Cancel streaming
// --------------------------------------------------------------------------

async function captureCancelStream(): Promise<string[]> {
  // Synthetic output showing a cancelled response
  const { rgb, bold: ansiBold } = await import("../tui/core/ansi.js");
  const ctp = {
    teal: rgb(0x94, 0xe2, 0xd5),
    overlay0: rgb(0x6c, 0x70, 0x86),
    subtext1: rgb(0xba, 0xc2, 0xde),
  };

  const lines = [
    "",
    `  ${ansiBold(ctp.teal("\u25c6"))} ${ansiBold(ctp.teal("assistant"))}`,
    "",
    `  Here's a comprehensive guide to setting up a production-ready`,
    `  Kubernetes cluster with automated scaling. First, you'll need`,
    `  to configure the control plane components:`,
    "",
    `  1. **API Server** \u2014 The central management entity that exposes`,
    `     the Kubernetes API. Configure with:`,
    "",
    `  \`\`\`yaml`,
    `  apiVersion: kubeadm.k8s.io/v1beta3`,
    `  kind: ClusterConfiguration`,
    `  kubernetesVersion: v1.29.0`,
    `  networking:`,
    `    podSubnet: 10.244.0.0/16`,
    `  \`\`\``,
    "",
    `  2. **etcd** \u2014 The backing store for all cluster data. For HA`,
    `     setups, run a 3-node etcd cluster across`,
    "",
    `  ${ctp.overlay0("\u238b Cancelled")}`,
    "",
    `  ${ctp.subtext1("\u25b8 ")}${ctp.overlay0("_")}`,
    "",
  ];
  return lines;
}

// --------------------------------------------------------------------------
// 7. Filter demo
// --------------------------------------------------------------------------

async function captureFilterDemo(): Promise<string[]> {
  // Synthetic model picker with filter active
  const { rgb, bold: ansiBold } = await import("../tui/core/ansi.js");
  const ctp = {
    mauve: rgb(0xcb, 0xa6, 0xf7),
    green: rgb(0xa6, 0xe3, 0xa1),
    overlay0: rgb(0x6c, 0x70, 0x86),
    overlay1: rgb(0x7f, 0x84, 0x9c),
    blue: rgb(0x89, 0xb4, 0xfa),
    text: rgb(0xcd, 0xd6, 0xf4),
  };

  const lines = [
    "  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
    `  \u2502 ${ansiBold(ctp.mauve("\u26a1 Models"))}${" ".repeat(18)}${ctp.overlay0("filter:")} ${ctp.text("qwen")}${ctp.blue("\u25cc")}   \u2502`,
    "  \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
    `  \u2502     ${ctp.green("\u25cf")} ${ctp.overlay1("ollama")}                              \u2502`,
    `  \u2502       ${ctp.mauve("\u25b8 ")}${ansiBold("qwen3.5:4b")}  ${ctp.overlay0("4k ctx")}                  \u2502`,
    `  \u2502         ${ctp.text("qwen3.5:2b")}  ${ctp.overlay0("4k ctx")}  ${ctp.green("\u2190 current")}      \u2502`,
    `  \u2502                                                 \u2502`,
    "  \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
    `  \u2502 ${ctp.overlay0("\u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc close")}          \u2502`,
    "  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
    "",
    `  ${ctp.overlay0("2 models match \"qwen\" \u2014 type to narrow, Enter to select")}`,
  ];
  return lines;
}

// --------------------------------------------------------------------------
// 8. Chat response with tool calls
// --------------------------------------------------------------------------

async function captureChatResponse(): Promise<string[]> {
  const { rgb, bold: ansiBold } = await import("../tui/core/ansi.js");
  const ctp = {
    teal: rgb(0x94, 0xe2, 0xd5),
    green: rgb(0xa6, 0xe3, 0xa1),
    overlay0: rgb(0x6c, 0x70, 0x86),
    blue: rgb(0x89, 0xb4, 0xfa),
    peach: rgb(0xfa, 0xb3, 0x87),
  };

  const lines = [
    "",
    `  ${ansiBold(ctp.blue("\u25c6"))} ${ansiBold(ctp.blue("user"))}`,
    `  Read package.json and tell me the dependencies`,
    "",
    `  ${ansiBold(ctp.teal("\u25c6"))} ${ansiBold(ctp.teal("coder"))}`,
    `  ${ctp.green("\u2713")} Reading package.json ${ctp.overlay0("(0.1s)")}`,
    `  ${ctp.green("\u2713")} Reading tsconfig.json ${ctp.overlay0("(0.1s)")}`,
    "",
    `  Here are the key dependencies in your project:`,
    "",
    `  **Runtime:**`,
    `  - ${ctp.peach("neverthrow")} \u2014 Type-safe error handling with Result types`,
    `  - ${ctp.peach("zod")} \u2014 Schema validation for tool inputs`,
    `  - ${ctp.peach("@anthropic-ai/sdk")} \u2014 Anthropic Claude API client`,
    `  - ${ctp.peach("@lancedb/lancedb")} \u2014 Vector database for memory system`,
    "",
    `  **Dev:**`,
    `  - ${ctp.peach("tsup")} \u2014 TypeScript bundler`,
    `  - ${ctp.peach("typescript")} 5.7 \u2014 Type checking`,
    `  - ${ctp.peach("eslint")} \u2014 Linting`,
    "",
    `  Total: ${ansiBold("12 runtime")} + ${ansiBold("8 dev")} dependencies.`,
    `  The project uses ESM modules with Bun as the runtime.`,
  ];
  return lines;
}

// ── Screenshot registry ─────────────────────────────────────────────────────

const SCREENSHOTS: Screenshot[] = [
  { name: "welcome", description: "Welcome screen with help", capture: captureWelcome },
  { name: "chat-response", description: "Agent response with tool calls", capture: captureChatResponse },
  { name: "sprint-output", description: "Sprint mode task execution", capture: captureSprintOutput },
  { name: "model-view", description: "/model provider selection", capture: captureModelView },
  { name: "cancel-stream", description: "Escape cancellation", capture: captureCancelStream },
  { name: "token-status", description: "Status bar with tokens", capture: captureStatusBar },
  { name: "settings-view", description: "Settings panel", capture: captureSettings },
  { name: "filter-demo", description: "Type-to-filter in model list", capture: captureFilterDemo },
];

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    console.log("\nAvailable screenshots:");
    for (const s of SCREENSHOTS) {
      console.log(`  ${s.name.padEnd(20)} ${pc.dim(s.description)}`);
    }
    console.log(`\nUsage: bun run tsx src/testing/screenshot-automation.ts [name]\n`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n${pc.bold("Screenshot Automation")}`);
  console.log(pc.dim(`Output: ${OUT_DIR}\n`));

  const targets = args.length > 0
    ? SCREENSHOTS.filter((s) => args.includes(s.name))
    : SCREENSHOTS;

  if (targets.length === 0) {
    console.log(pc.red(`No screenshots matching: ${args.join(", ")}`));
    console.log(pc.dim("Run with --list to see available screenshots"));
    process.exit(1);
  }

  let succeeded = 0;

  for (const shot of targets) {
    process.stdout.write(`${shot.name.padEnd(20)} `);
    try {
      const lines = await shot.capture();
      const svg = ansiToSvg(lines, { ...SVG_OPTS, title: `openpawl \u2014 ${shot.description}` });
      saveSvg(shot.name, svg);
      succeeded++;
    } catch (err) {
      console.log(`  ${pc.red("\u2717")} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${pc.bold(`${succeeded}/${targets.length} screenshots generated`)}\n`);

  // Exit (TUI may have spawned timers)
  process.exit(0);
}

main().catch((err) => {
  console.error(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
