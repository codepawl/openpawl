# CONTEXT.md Handoff Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-generate a human-readable CONTEXT.md handoff file at session end that captures full project state for solo devs switching machines or collaborators onboarding.

**Architecture:** New `src/handoff/` module with collector, renderer, state-deriver, resume-generator, and importer. Triggered async after post-mortem in work-runner. CLI `openpawl handoff` command for manual generation/import. Dashboard HandoffPanel for web UI. Handoff config added to global config under `handoff` key.

**Tech Stack:** TypeScript (ESM), Node.js fs/promises, Fastify (web endpoints), React (dashboard panel), Vitest (tests).

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/handoff/types.ts` | HandoffData, LeftToDoItem, HandoffConfig types |
| Create | `src/handoff/state-deriver.ts` | Convert task descriptions to past-tense state bullets |
| Create | `src/handoff/resume-generator.ts` | Generate openpawl commands from leftToDo items |
| Create | `src/handoff/collector.ts` | Assemble HandoffData from GraphState + stores |
| Create | `src/handoff/renderer.ts` | Render HandoffData → CommonMark CONTEXT.md |
| Create | `src/handoff/importer.ts` | Parse CONTEXT.md, import decisions, show briefing |
| Create | `src/handoff/index.ts` | Barrel export |
| Create | `src/commands/handoff.ts` | CLI subcommand: generate, import, preview |
| Create | `src/web/client/src/components/HandoffPanel.tsx` | Dashboard tab |
| Create | `tests/handoff-state-deriver.test.ts` | State deriver tests |
| Create | `tests/handoff-renderer.test.ts` | Renderer tests |
| Create | `tests/handoff-collector.test.ts` | Collector tests |
| Create | `tests/handoff-importer.test.ts` | Importer tests |
| Modify | `src/cli/fuzzy-matcher.ts:8-49` | Add "handoff" to COMMANDS and SUBCOMMANDS |
| Modify | `src/cli.ts:378` | Add handoff command routing |
| Modify | `src/core/global-config.ts:5-38` | Add handoff to OpenPawlGlobalConfig |
| Modify | `src/work-runner.ts:1396-1399` | Trigger auto-generation after audit export |
| Modify | `src/briefing/collector.ts:18-28` | Check for CONTEXT.md in cwd |
| Modify | `src/web/server.ts` | Add /api/handoff endpoints |

---

## Task 1: Types

**Files:**
- Create: `src/handoff/types.ts`

- [ ] **Step 1: Write types file**

```typescript
// src/handoff/types.ts
import type { Decision } from "../journal/types.js";

export interface HandoffConfig {
  autoGenerate: boolean;
  outputPath: string;
  keepHistory: boolean;
  gitCommit: boolean;
}

export const DEFAULT_HANDOFF_CONFIG: HandoffConfig = {
  autoGenerate: true,
  outputPath: "./CONTEXT.md",
  keepHistory: true,
  gitCommit: false,
};

export interface LeftToDoItem {
  description: string;
  type: "deferred" | "escalated" | "approved_rfc" | "open_task";
  priority: "high" | "medium" | "low";
  command?: string;
}

export interface TeamPerformanceEntry {
  agentRole: string;
  trend: string;
  avgConfidence: number;
  note: string;
}

export interface HandoffData {
  generatedAt: number;
  sessionId: string;
  projectPath: string;
  completedGoal: string;
  sessionStatus: "complete" | "partial" | "failed";
  currentState: string[];
  activeDecisions: Decision[];
  leftToDo: LeftToDoItem[];
  teamLearnings: string[];
  teamPerformance: TeamPerformanceEntry[];
  resumeCommands: string[];
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit src/handoff/types.ts 2>&1 | head -5`
Note: We'll do a full typecheck at the end. Just a sanity check here.

- [ ] **Step 3: Commit**

```bash
git add src/handoff/types.ts
git commit -m "feat(handoff): add HandoffData and config types"
```

---

## Task 2: State Deriver

**Files:**
- Create: `src/handoff/state-deriver.ts`
- Create: `tests/handoff-state-deriver.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/handoff-state-deriver.test.ts
import { describe, it, expect } from "vitest";
import { deriveCurrentState } from "../src/handoff/state-deriver.js";

describe("deriveCurrentState", () => {
  it("converts 'Implement X' to 'X implemented'", () => {
    const tasks = [{ description: "Implement OAuth2 PKCE flow", confidence: 0.9 }];
    const result = deriveCurrentState(tasks);
    expect(result).toEqual(["OAuth2 PKCE flow implemented"]);
  });

  it("converts 'Add X' to 'X added'", () => {
    const tasks = [{ description: "Add token refresh logic", confidence: 0.8 }];
    const result = deriveCurrentState(tasks);
    expect(result).toEqual(["Token refresh logic added"]);
  });

  it("converts 'Write X' to 'X written'", () => {
    const tasks = [{ description: "Write integration tests", confidence: 0.7 }];
    const result = deriveCurrentState(tasks);
    expect(result).toEqual(["Integration tests written"]);
  });

  it("converts 'Fix X' to 'X fixed'", () => {
    const tasks = [{ description: "Fix login redirect bug", confidence: 0.8 }];
    const result = deriveCurrentState(tasks);
    expect(result).toEqual(["Login redirect bug fixed"]);
  });

  it("converts 'Refactor X' to 'X refactored'", () => {
    const tasks = [{ description: "Refactor auth module", confidence: 0.9 }];
    const result = deriveCurrentState(tasks);
    expect(result).toEqual(["Auth module refactored"]);
  });

  it("handles unknown verbs gracefully by appending 'completed'", () => {
    const tasks = [{ description: "Deploy the new API", confidence: 0.8 }];
    const result = deriveCurrentState(tasks);
    expect(result).toEqual(["Deploy the new API — completed"]);
  });

  it("limits output to 5 bullets", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      description: `Add feature ${i}`,
      confidence: 0.9 - i * 0.05,
    }));
    const result = deriveCurrentState(tasks);
    expect(result.length).toBe(5);
  });

  it("picks highest confidence tasks when limiting", () => {
    const tasks = [
      { description: "Add low priority thing", confidence: 0.3 },
      { description: "Implement critical feature", confidence: 0.95 },
    ];
    const result = deriveCurrentState(tasks);
    expect(result[0]).toBe("Critical feature implemented");
  });

  it("returns empty array for empty input", () => {
    expect(deriveCurrentState([])).toEqual([]);
  });

  it("handles descriptions with leading/trailing whitespace", () => {
    const tasks = [{ description: "  Fix  the bug  ", confidence: 0.8 }];
    const result = deriveCurrentState(tasks);
    expect(result).toEqual(["The bug fixed"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/handoff-state-deriver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/handoff/state-deriver.ts

interface CompletedTask {
  description: string;
  confidence: number;
}

const VERB_RULES: Array<{ pattern: RegExp; transform: (rest: string) => string }> = [
  { pattern: /^implement\s+/i, transform: (rest) => `${rest} implemented` },
  { pattern: /^add\s+/i, transform: (rest) => `${rest} added` },
  { pattern: /^write\s+/i, transform: (rest) => `${rest} written` },
  { pattern: /^fix\s+/i, transform: (rest) => `${rest} fixed` },
  { pattern: /^refactor\s+/i, transform: (rest) => `${rest} refactored` },
  { pattern: /^create\s+/i, transform: (rest) => `${rest} created` },
  { pattern: /^update\s+/i, transform: (rest) => `${rest} updated` },
  { pattern: /^remove\s+/i, transform: (rest) => `${rest} removed` },
  { pattern: /^delete\s+/i, transform: (rest) => `${rest} deleted` },
  { pattern: /^configure\s+/i, transform: (rest) => `${rest} configured` },
  { pattern: /^set up\s+/i, transform: (rest) => `${rest} set up` },
  { pattern: /^migrate\s+/i, transform: (rest) => `${rest} migrated` },
  { pattern: /^build\s+/i, transform: (rest) => `${rest} built` },
  { pattern: /^design\s+/i, transform: (rest) => `${rest} designed` },
  { pattern: /^test\s+/i, transform: (rest) => `${rest} tested` },
];

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toPastTense(description: string): string {
  const trimmed = description.trim().replace(/\s+/g, " ");

  for (const rule of VERB_RULES) {
    const match = trimmed.match(rule.pattern);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return capitalize(rule.transform(rest));
    }
  }

  return `${trimmed} — completed`;
}

export function deriveCurrentState(tasks: CompletedTask[]): string[] {
  if (tasks.length === 0) return [];

  const sorted = [...tasks].sort((a, b) => b.confidence - a.confidence);
  const top = sorted.slice(0, 5);

  return top.map((t) => toPastTense(t.description));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/handoff-state-deriver.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/handoff/state-deriver.ts tests/handoff-state-deriver.test.ts
git commit -m "feat(handoff): add state deriver with verb-to-past-tense rules"
```

---

## Task 3: Resume Command Generator

**Files:**
- Create: `src/handoff/resume-generator.ts`

- [ ] **Step 1: Write implementation**

```typescript
// src/handoff/resume-generator.ts
import type { LeftToDoItem } from "./types.js";

export function generateResumeCommands(
  leftToDo: LeftToDoItem[],
  decisionCount: number,
): string[] {
  const commands: string[] = [];

  // One command per leftToDo item, max 3
  for (const item of leftToDo.slice(0, 3)) {
    if (item.command) {
      commands.push(item.command);
    } else {
      commands.push(`openpawl work --goal "${item.description}"`);
    }
  }

  // Suggest journal review if many decisions
  if (decisionCount > 3) {
    commands.push("openpawl journal list");
  }

  // Suggest think mode for escalated items
  const hasEscalated = leftToDo.some((i) => i.type === "escalated");
  if (hasEscalated) {
    const escalated = leftToDo.find((i) => i.type === "escalated");
    if (escalated) {
      commands.push(`openpawl think "${escalated.description}"`);
    }
  }

  return commands;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/handoff/resume-generator.ts
git commit -m "feat(handoff): add resume command generator"
```

---

## Task 4: Collector

**Files:**
- Create: `src/handoff/collector.ts`
- Create: `tests/handoff-collector.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/handoff-collector.test.ts
import { describe, it, expect } from "vitest";
import { buildHandoffData } from "../src/handoff/collector.js";

describe("buildHandoffData", () => {
  const baseInput = {
    sessionId: "sess_test_123",
    projectPath: "/tmp/myproject",
    goal: "Build auth module",
    taskQueue: [] as Array<Record<string, unknown>>,
    nextSprintBacklog: [] as Array<Record<string, unknown>>,
    promotedThisRun: [] as string[],
    agentProfiles: [] as Array<Record<string, unknown>>,
    activeDecisions: [] as Array<{ decision: string; reasoning: string; recommendedBy: string; confidence: number; capturedAt: number; id: string; sessionId: string; runIndex: number; topic: string; taskId: string; goalContext: string; tags: string[]; embedding: number[]; status: "active" | "superseded" | "reconsidered" }>,
    rfcDocument: null as string | null,
  };

  it("derives sessionStatus 'complete' when all tasks done", () => {
    const input = {
      ...baseInput,
      taskQueue: [
        { status: "completed", description: "Task 1", confidence: 0.9 },
        { status: "completed", description: "Task 2", confidence: 0.8 },
      ],
    };
    const result = buildHandoffData(input);
    expect(result.sessionStatus).toBe("complete");
  });

  it("derives sessionStatus 'failed' when majority failed", () => {
    const input = {
      ...baseInput,
      taskQueue: [
        { status: "failed", description: "Task 1", confidence: 0.5 },
        { status: "failed", description: "Task 2", confidence: 0.4 },
        { status: "completed", description: "Task 3", confidence: 0.9 },
      ],
    };
    const result = buildHandoffData(input);
    expect(result.sessionStatus).toBe("failed");
  });

  it("derives sessionStatus 'partial' when mixed results", () => {
    const input = {
      ...baseInput,
      taskQueue: [
        { status: "completed", description: "Task 1", confidence: 0.9 },
        { status: "failed", description: "Task 2", confidence: 0.5 },
        { status: "completed", description: "Task 3", confidence: 0.8 },
      ],
    };
    const result = buildHandoffData(input);
    expect(result.sessionStatus).toBe("partial");
  });

  it("limits activeDecisions to 5", () => {
    const decisions = Array.from({ length: 8 }, (_, i) => ({
      id: `dec_${i}`,
      sessionId: "sess_test",
      runIndex: 0,
      capturedAt: Date.now() - i * 1000,
      topic: "auth",
      decision: `Decision ${i}`,
      reasoning: `Reason ${i}`,
      recommendedBy: "tech_lead",
      confidence: 0.8,
      taskId: `task_${i}`,
      goalContext: "Build auth",
      tags: [],
      embedding: [],
      status: "active" as const,
    }));
    const input = { ...baseInput, activeDecisions: decisions };
    const result = buildHandoffData(input);
    expect(result.activeDecisions.length).toBe(5);
  });

  it("limits teamLearnings to 5", () => {
    const input = {
      ...baseInput,
      promotedThisRun: Array.from({ length: 8 }, (_, i) => `Lesson ${i}`),
    };
    const result = buildHandoffData(input);
    expect(result.teamLearnings.length).toBe(5);
  });

  it("limits currentState to 5 bullets", () => {
    const input = {
      ...baseInput,
      taskQueue: Array.from({ length: 10 }, (_, i) => ({
        status: "completed",
        description: `Implement feature ${i}`,
        confidence: 0.9,
      })),
    };
    const result = buildHandoffData(input);
    expect(result.currentState.length).toBe(5);
  });

  it("includes escalated items in leftToDo", () => {
    const input = {
      ...baseInput,
      nextSprintBacklog: [
        { description: "Escalated task", reason: "escalated" },
      ],
    };
    const result = buildHandoffData(input);
    expect(result.leftToDo.length).toBe(1);
    expect(result.leftToDo[0]!.type).toBe("escalated");
  });

  it("includes approved RFC in leftToDo", () => {
    const input = {
      ...baseInput,
      rfcDocument: "# Caching Layer RFC\nApproved design for caching",
    };
    const result = buildHandoffData(input);
    expect(result.leftToDo.some((i) => i.type === "approved_rfc")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/handoff-collector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/handoff/collector.ts
import type { Decision } from "../journal/types.js";
import type { HandoffData, LeftToDoItem, TeamPerformanceEntry } from "./types.js";
import { deriveCurrentState } from "./state-deriver.js";
import { generateResumeCommands } from "./resume-generator.js";

export interface CollectorInput {
  sessionId: string;
  projectPath: string;
  goal: string;
  taskQueue: Array<Record<string, unknown>>;
  nextSprintBacklog: Array<Record<string, unknown>>;
  promotedThisRun: string[];
  agentProfiles: Array<Record<string, unknown>>;
  activeDecisions: Decision[];
  rfcDocument: string | null;
}

function deriveSessionStatus(
  completed: number,
  failed: number,
): "complete" | "partial" | "failed" {
  if (completed === 0 && failed === 0) return "complete";
  if (failed === 0) return "complete";
  if (failed >= completed) return "failed";
  return "partial";
}

function deriveLeftToDo(
  backlog: Array<Record<string, unknown>>,
  rfcDocument: string | null,
): LeftToDoItem[] {
  const items: LeftToDoItem[] = [];

  for (const item of backlog) {
    const desc = (item.description as string) ?? (item.task_id as string) ?? "Unknown task";
    const reason = (item.reason as string) ?? "deferred";

    let type: LeftToDoItem["type"] = "open_task";
    let priority: LeftToDoItem["priority"] = "medium";

    if (reason === "escalated") {
      type = "escalated";
      priority = "high";
    } else if (reason === "deferred") {
      type = "deferred";
      priority = "medium";
    }

    items.push({ description: desc, type, priority });
  }

  // Add RFC if present
  if (rfcDocument && rfcDocument.trim()) {
    const firstLine = rfcDocument.trim().split("\n")[0] ?? "RFC draft";
    const title = firstLine.replace(/^#+\s*/, "").trim();
    items.push({
      description: `Execute ${title}`,
      type: "approved_rfc",
      priority: "medium",
      command: `openpawl work --goal "Execute ${title}"`,
    });
  }

  return items;
}

function deriveTeamPerformance(
  profiles: Array<Record<string, unknown>>,
): TeamPerformanceEntry[] {
  const entries: TeamPerformanceEntry[] = [];

  for (const profile of profiles) {
    const role = (profile.agentRole as string) ?? (profile.role as string) ?? "";
    if (!role) continue;

    const scoreHistory = (profile.scoreHistory as number[]) ?? [];
    const overallScore = (profile.overallScore as number) ?? 0;

    let trend = "stable";
    let confidenceDelta = 0;

    if (scoreHistory.length >= 2) {
      const recent = scoreHistory[scoreHistory.length - 1]!;
      const previous = scoreHistory[scoreHistory.length - 2]!;
      confidenceDelta = recent - previous;
      if (confidenceDelta > 0.03) trend = "improving";
      else if (confidenceDelta < -0.03) trend = "degrading";
    }

    let note = `${overallScore.toFixed(2)} avg`;
    if (trend === "improving") {
      note = `improving (+${confidenceDelta.toFixed(2)} this week)`;
    } else if (trend === "degrading") {
      note = `watch (${confidenceDelta.toFixed(2)} this week)`;
    } else {
      note = `stable (${overallScore.toFixed(2)} avg)`;
    }

    // Extract strengths for note
    const strengths = (profile.strengths as string[]) ?? [];
    if (strengths.length > 0) {
      note += ` — strong on ${strengths.slice(0, 2).join(" and ")}`;
    }

    entries.push({ agentRole: role, trend, avgConfidence: overallScore, note });
  }

  return entries;
}

export function buildHandoffData(input: CollectorInput): HandoffData {
  const taskQueue = input.taskQueue;
  const completed = taskQueue.filter((t) => t.status === "completed");
  const failed = taskQueue.filter((t) => t.status === "failed");

  const sessionStatus = deriveSessionStatus(completed.length, failed.length);

  const currentState = deriveCurrentState(
    completed.map((t) => ({
      description: (t.description as string) ?? "",
      confidence: (t.confidence as number) ?? 0,
    })),
  );

  const leftToDo = deriveLeftToDo(input.nextSprintBacklog, input.rfcDocument);
  const teamLearnings = input.promotedThisRun.slice(0, 5);
  const teamPerformance = deriveTeamPerformance(input.agentProfiles);
  const activeDecisions = input.activeDecisions
    .filter((d) => d.status === "active")
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, 5);

  const resumeCommands = generateResumeCommands(leftToDo, activeDecisions.length);

  return {
    generatedAt: Date.now(),
    sessionId: input.sessionId,
    projectPath: input.projectPath,
    completedGoal: input.goal,
    sessionStatus,
    currentState,
    activeDecisions,
    leftToDo,
    teamLearnings,
    teamPerformance,
    resumeCommands,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/handoff-collector.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/handoff/collector.ts tests/handoff-collector.test.ts
git commit -m "feat(handoff): add data collector with status derivation and limits"
```

---

## Task 5: Renderer

**Files:**
- Create: `src/handoff/renderer.ts`
- Create: `tests/handoff-renderer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/handoff-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderContextMarkdown } from "../src/handoff/renderer.js";
import type { HandoffData } from "../src/handoff/types.js";

function makeHandoffData(overrides: Partial<HandoffData> = {}): HandoffData {
  return {
    generatedAt: new Date("2026-03-17T14:32:00Z").getTime(),
    sessionId: "sess_abc123",
    projectPath: "/home/user/projects/myapp",
    completedGoal: "Refactor auth module to use OAuth2",
    sessionStatus: "complete",
    currentState: [
      "OAuth2 with PKCE flow implemented and tested",
      "Token refresh logic added",
    ],
    activeDecisions: [
      {
        id: "dec1", sessionId: "sess_abc123", runIndex: 0,
        capturedAt: Date.now(), topic: "auth",
        decision: "Use PKCE flow for OAuth2",
        reasoning: "Implicit flow exposes tokens in URL fragments",
        recommendedBy: "tech_lead", confidence: 0.92,
        taskId: "t1", goalContext: "auth", tags: [], embedding: [],
        status: "active",
      },
    ],
    leftToDo: [
      { description: "Execute caching layer RFC", type: "approved_rfc", priority: "medium" },
      { description: "Add rate limiting", type: "deferred", priority: "low" },
    ],
    teamLearnings: ["PKCE flow preferred over implicit for SPA auth"],
    teamPerformance: [
      { agentRole: "Worker Bot", trend: "improving", avgConfidence: 0.85, note: "improving (+0.08 this week) — strong on implementation" },
    ],
    resumeCommands: [
      'openpawl work --goal "Execute caching layer RFC"',
      "openpawl journal list",
    ],
    ...overrides,
  };
}

describe("renderContextMarkdown", () => {
  it("produces valid CommonMark under 150 lines", () => {
    const data = makeHandoffData();
    const md = renderContextMarkdown(data);
    const lines = md.split("\n");
    expect(lines.length).toBeLessThanOrEqual(150);
  });

  it("contains all 6 required sections", () => {
    const data = makeHandoffData();
    const md = renderContextMarkdown(data);
    expect(md).toContain("## Where We Are");
    expect(md).toContain("## Active Decisions");
    expect(md).toContain("## Left To Do");
    expect(md).toContain("## What The Team Learned");
    expect(md).toContain("## Team Performance");
    expect(md).toContain("## How To Resume");
  });

  it("includes the generated timestamp", () => {
    const data = makeHandoffData();
    const md = renderContextMarkdown(data);
    expect(md).toContain("**Generated:**");
    expect(md).toContain("2026");
  });

  it("includes session ID and project path", () => {
    const data = makeHandoffData();
    const md = renderContextMarkdown(data);
    expect(md).toContain("sess_abc123");
    expect(md).toContain("/home/user/projects/myapp");
  });

  it("renders status emoji correctly for complete", () => {
    const md = renderContextMarkdown(makeHandoffData({ sessionStatus: "complete" }));
    expect(md).toMatch(/✅/);
  });

  it("renders status emoji correctly for failed", () => {
    const md = renderContextMarkdown(makeHandoffData({ sessionStatus: "failed" }));
    expect(md).toMatch(/❌/);
  });

  it("renders status emoji correctly for partial", () => {
    const md = renderContextMarkdown(makeHandoffData({ sessionStatus: "partial" }));
    expect(md).toMatch(/⚠️/);
  });

  it("renders decisions with numbering", () => {
    const md = renderContextMarkdown(makeHandoffData());
    expect(md).toContain("1. **Use PKCE flow for OAuth2**");
  });

  it("renders leftToDo as checkbox items", () => {
    const md = renderContextMarkdown(makeHandoffData());
    expect(md).toContain("- [ ] Execute caching layer RFC");
  });

  it("renders resume commands as code", () => {
    const md = renderContextMarkdown(makeHandoffData());
    expect(md).toContain("openpawl work --goal");
  });

  it("omits Team Performance section when no profiles", () => {
    const md = renderContextMarkdown(makeHandoffData({ teamPerformance: [] }));
    expect(md).not.toContain("## Team Performance");
  });

  it("omits What The Team Learned section when no learnings", () => {
    const md = renderContextMarkdown(makeHandoffData({ teamLearnings: [] }));
    expect(md).not.toContain("## What The Team Learned");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/handoff-renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/handoff/renderer.ts
import type { HandoffData } from "./types.js";

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function statusEmoji(status: HandoffData["sessionStatus"]): string {
  if (status === "complete") return "✅ Complete";
  if (status === "failed") return "❌ Failed";
  return "⚠️ Partial";
}

export function renderContextMarkdown(data: HandoffData): string {
  const lines: string[] = [];

  // Header
  lines.push("# OpenPawl Project Context");
  lines.push(`**Generated:** ${formatDate(data.generatedAt)}`);
  lines.push(`**Session:** ${data.sessionId}`);
  lines.push(`**Project:** ${data.projectPath}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Where We Are
  lines.push("## Where We Are");
  lines.push(`Goal: "${data.completedGoal}"`);
  lines.push(`Status: ${statusEmoji(data.sessionStatus)}`);
  lines.push("");
  if (data.currentState.length > 0) {
    lines.push("Current project state:");
    for (const bullet of data.currentState) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
  }

  // Active Decisions
  lines.push("---");
  lines.push("");
  lines.push("## Active Decisions");
  if (data.activeDecisions.length === 0) {
    lines.push("No active decisions from this session.");
  } else {
    lines.push("These decisions are in effect — honor them in future sessions:");
    lines.push("");
    for (let i = 0; i < data.activeDecisions.length; i++) {
      const d = data.activeDecisions[i]!;
      const conf = d.confidence >= 0.8 ? "high" : d.confidence >= 0.5 ? "medium" : "low";
      lines.push(`${i + 1}. **${d.decision}** (${d.recommendedBy}, ${conf} confidence)`);
      lines.push(`   Reasoning: "${d.reasoning}"`);
      lines.push("");
    }
  }

  // Left To Do
  lines.push("---");
  lines.push("");
  lines.push("## Left To Do");
  if (data.leftToDo.length === 0) {
    lines.push("Nothing left — all items completed this session.");
  } else {
    lines.push("These items are ready to pick up in the next session:");
    lines.push("");
    for (const item of data.leftToDo) {
      const tag = item.type === "escalated" ? " — escalated, needs decision"
        : item.type === "approved_rfc" ? " — approved, not started"
        : item.type === "deferred" ? " — deferred"
        : "";
      lines.push(`- [ ] ${item.description}${tag}`);
    }
  }
  lines.push("");

  // What The Team Learned
  if (data.teamLearnings.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## What The Team Learned");
    lines.push("Lessons from this session (added to global memory):");
    lines.push("");
    for (const lesson of data.teamLearnings) {
      lines.push(`- ${lesson}`);
    }
    lines.push("");
  }

  // Team Performance
  if (data.teamPerformance.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Team Performance");
    for (const perf of data.teamPerformance) {
      lines.push(`- ${perf.agentRole}: ${perf.note}`);
    }
    lines.push("");
  }

  // How To Resume
  lines.push("---");
  lines.push("");
  lines.push("## How To Resume");
  lines.push("```bash");
  lines.push("openpawl work");
  lines.push("```");
  lines.push("The team will brief you automatically on everything above.");
  if (data.resumeCommands.length > 0) {
    lines.push("");
    lines.push("To pick up specific items:");
    lines.push("```bash");
    for (const cmd of data.resumeCommands) {
      lines.push(cmd);
    }
    lines.push("```");
  }
  lines.push("");

  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/handoff-renderer.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/handoff/renderer.ts tests/handoff-renderer.test.ts
git commit -m "feat(handoff): add CONTEXT.md renderer with 6-section layout"
```

---

## Task 6: Importer

**Files:**
- Create: `src/handoff/importer.ts`
- Create: `tests/handoff-importer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/handoff-importer.test.ts
import { describe, it, expect } from "vitest";
import { parseContextMarkdown } from "../src/handoff/importer.js";

const SAMPLE_CONTEXT = `# OpenPawl Project Context
**Generated:** 2026-03-17 14:32:00 UTC
**Session:** sess_abc123
**Project:** /home/user/myapp

---

## Where We Are
Goal: "Refactor auth module"
Status: ✅ Complete

Current project state:
- OAuth2 with PKCE flow implemented
- Token refresh logic added

---

## Active Decisions
These decisions are in effect — honor them in future sessions:

1. **Use PKCE flow for OAuth2** (tech_lead, high confidence)
   Reasoning: "Implicit flow exposes tokens in URL fragments"

2. **Avoid Redis for session storage** (rfc_author, high confidence)
   Reasoning: "Stateless JWT chosen for scalability"

---

## Left To Do
These items are ready to pick up in the next session:

- [ ] Execute caching layer RFC — approved, not started
- [ ] Add rate limiting — deferred

---

## What The Team Learned
Lessons from this session (added to global memory):

- PKCE flow preferred over implicit for SPA auth

---

## Team Performance
- Worker Bot: improving (+0.08 this week) — strong on implementation

---

## How To Resume
\`\`\`bash
openpawl work
\`\`\`
`;

describe("parseContextMarkdown", () => {
  it("extracts current state bullets", () => {
    const parsed = parseContextMarkdown(SAMPLE_CONTEXT);
    expect(parsed.currentState).toContain("OAuth2 with PKCE flow implemented");
    expect(parsed.currentState).toContain("Token refresh logic added");
  });

  it("extracts active decisions", () => {
    const parsed = parseContextMarkdown(SAMPLE_CONTEXT);
    expect(parsed.decisions.length).toBe(2);
    expect(parsed.decisions[0]!.decision).toBe("Use PKCE flow for OAuth2");
    expect(parsed.decisions[0]!.reasoning).toBe("Implicit flow exposes tokens in URL fragments");
  });

  it("extracts left-to-do items", () => {
    const parsed = parseContextMarkdown(SAMPLE_CONTEXT);
    expect(parsed.leftToDo.length).toBe(2);
    expect(parsed.leftToDo[0]).toContain("Execute caching layer RFC");
  });

  it("does NOT extract team performance", () => {
    const parsed = parseContextMarkdown(SAMPLE_CONTEXT);
    expect(parsed.teamPerformance).toEqual([]);
  });

  it("works on minimal CONTEXT.md with only header", () => {
    const minimal = `# OpenPawl Project Context\n**Generated:** 2026-03-17\n**Session:** sess_min\n**Project:** /tmp\n`;
    const parsed = parseContextMarkdown(minimal);
    expect(parsed.sessionId).toBe("sess_min");
    expect(parsed.decisions).toEqual([]);
    expect(parsed.leftToDo).toEqual([]);
  });

  it("handles missing sections gracefully", () => {
    const partial = `# OpenPawl Project Context
**Generated:** 2026-03-17
**Session:** sess_partial
**Project:** /tmp

---

## Where We Are
Goal: "Test"
Status: ✅ Complete
`;
    const parsed = parseContextMarkdown(partial);
    expect(parsed.decisions).toEqual([]);
    expect(parsed.leftToDo).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/handoff-importer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/handoff/importer.ts
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ParsedContext {
  sessionId: string;
  projectPath: string;
  currentState: string[];
  decisions: Array<{ decision: string; reasoning: string; recommendedBy: string }>;
  leftToDo: string[];
  teamPerformance: never[]; // intentionally empty — not imported
}

export function parseContextMarkdown(content: string): ParsedContext {
  const result: ParsedContext = {
    sessionId: "",
    projectPath: "",
    currentState: [],
    decisions: [],
    leftToDo: [],
    teamPerformance: [],
  };

  // Extract header metadata
  const sessionMatch = content.match(/\*\*Session:\*\*\s*(.+)/);
  if (sessionMatch) result.sessionId = sessionMatch[1]!.trim();

  const projectMatch = content.match(/\*\*Project:\*\*\s*(.+)/);
  if (projectMatch) result.projectPath = projectMatch[1]!.trim();

  // Split into sections
  const sections = content.split(/^---$/m).map((s) => s.trim());

  for (const section of sections) {
    // Current state bullets
    if (section.includes("## Where We Are")) {
      const bulletMatches = section.match(/^- .+$/gm);
      if (bulletMatches) {
        result.currentState = bulletMatches.map((b) => b.replace(/^- /, "").trim());
      }
    }

    // Active decisions
    if (section.includes("## Active Decisions")) {
      const decisionBlocks = section.split(/^\d+\.\s+\*\*/m).slice(1);
      for (const block of decisionBlocks) {
        const titleMatch = block.match(/^(.+?)\*\*\s*\(([^,]+)/);
        const reasoningMatch = block.match(/Reasoning:\s*"([^"]+)"/);
        if (titleMatch) {
          result.decisions.push({
            decision: titleMatch[1]!.trim(),
            reasoning: reasoningMatch?.[1] ?? "",
            recommendedBy: titleMatch[2]!.trim(),
          });
        }
      }
    }

    // Left to do
    if (section.includes("## Left To Do")) {
      const checkboxMatches = section.match(/^- \[[ x]\] .+$/gm);
      if (checkboxMatches) {
        result.leftToDo = checkboxMatches.map((c) => c.replace(/^- \[[ x]\] /, "").trim());
      }
    }

    // Team performance — intentionally NOT parsed (machine-specific)
  }

  return result;
}

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export function isDuplicateDecision(
  newDecision: string,
  existingDecisions: Array<{ decision: string }>,
): boolean {
  const normalized = normalizeForComparison(newDecision);
  return existingDecisions.some((d) => {
    const existing = normalizeForComparison(d.decision);
    // Simple substring/similarity check
    if (existing === normalized) return true;
    // Check if one contains the other (handles minor variations)
    if (existing.includes(normalized) || normalized.includes(existing)) return true;
    return false;
  });
}

export async function importContextFile(
  contextPath: string,
): Promise<{
  imported: number;
  skipped: number;
  currentState: string[];
  leftToDo: string[];
} | null> {
  const resolved = path.resolve(contextPath);
  if (!existsSync(resolved)) return null;

  const content = await readFile(resolved, "utf-8");
  const parsed = parseContextMarkdown(content);

  let imported = 0;
  let skipped = 0;

  // Import decisions into journal (best-effort)
  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const { DecisionStore } = await import("../journal/store.js");

    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (embedder) {
      const globalMgr = new GlobalMemoryManager();
      await globalMgr.init(embedder);
      const db = globalMgr.getDb();
      if (db) {
        const store = new DecisionStore();
        await store.init(db);
        const existing = await store.getAll();

        for (const dec of parsed.decisions) {
          if (isDuplicateDecision(dec.decision, existing)) {
            skipped++;
            continue;
          }

          await store.upsert({
            id: `imported_${Date.now()}_${imported}`,
            sessionId: parsed.sessionId || `imported_${Date.now()}`,
            runIndex: 0,
            capturedAt: Date.now(),
            topic: "imported",
            decision: dec.decision,
            reasoning: dec.reasoning,
            recommendedBy: dec.recommendedBy,
            confidence: 0.8,
            taskId: "imported",
            goalContext: "Imported from CONTEXT.md",
            tags: ["imported"],
            embedding: [],
            status: "active",
          });
          imported++;
        }
      }
    }
  } catch {
    // On fresh install, decision import may fail — that's OK
    // Decisions are shown to user regardless
    imported = 0;
    skipped = 0;
  }

  return {
    imported,
    skipped,
    currentState: parsed.currentState,
    leftToDo: parsed.leftToDo,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/handoff-importer.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/handoff/importer.ts tests/handoff-importer.test.ts
git commit -m "feat(handoff): add CONTEXT.md parser and decision importer"
```

---

## Task 7: Barrel Export

**Files:**
- Create: `src/handoff/index.ts`

- [ ] **Step 1: Write barrel export**

```typescript
// src/handoff/index.ts
export type { HandoffData, LeftToDoItem, TeamPerformanceEntry, HandoffConfig } from "./types.js";
export { DEFAULT_HANDOFF_CONFIG } from "./types.js";
export { buildHandoffData } from "./collector.js";
export type { CollectorInput } from "./collector.js";
export { renderContextMarkdown } from "./renderer.js";
export { deriveCurrentState } from "./state-deriver.js";
export { generateResumeCommands } from "./resume-generator.js";
export { parseContextMarkdown, importContextFile, isDuplicateDecision } from "./importer.js";
```

- [ ] **Step 2: Commit**

```bash
git add src/handoff/index.ts
git commit -m "feat(handoff): add barrel export"
```

---

## Task 8: CLI Command

**Files:**
- Create: `src/commands/handoff.ts`
- Modify: `src/cli/fuzzy-matcher.ts:8,34-49`
- Modify: `src/cli.ts:378`

- [ ] **Step 1: Write CLI command**

```typescript
// src/commands/handoff.ts
import pc from "picocolors";
import { logger } from "../core/logger.js";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export async function runHandoffCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "import") {
    await handleImport();
    return;
  }

  // Parse flags
  let sessionId: string | undefined;
  let outputPath: string | undefined;
  let preview = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--session" && args[i + 1]) {
      sessionId = args[++i];
    } else if (arg === "--out" && args[i + 1]) {
      outputPath = args[++i];
    } else if (arg === "--preview") {
      preview = true;
    }
  }

  await handleGenerate(sessionId, outputPath, preview);
}

async function handleGenerate(
  sessionId?: string,
  outputPath?: string,
  preview = false,
): Promise<void> {
  const { buildHandoffData } = await import("../handoff/collector.js");
  const { renderContextMarkdown } = await import("../handoff/renderer.js");
  const { listSessions } = await import("../replay/session-index.js");
  const { readRecordingEvents } = await import("../replay/storage.js");
  const { DEFAULT_HANDOFF_CONFIG } = await import("../handoff/types.js");

  // Find session
  const sessions = listSessions(10);
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    const last = sessions.find((s) => s.completedAt > 0);
    if (!last) {
      logger.error("No completed sessions found.");
      return;
    }
    targetSessionId = last.sessionId;
  }

  const session = sessions.find((s) => s.sessionId === targetSessionId);
  if (!session) {
    logger.error(`Session not found: ${targetSessionId}`);
    return;
  }

  // Read recording to get final state
  let finalState: Record<string, unknown> = {};
  try {
    const events = await readRecordingEvents(targetSessionId);
    const exitEvents = events.filter((e) => e.phase === "exit");
    const lastExitEvent = exitEvents[exitEvents.length - 1];
    finalState = lastExitEvent?.stateAfter ?? {};
  } catch {
    logger.warn("Could not read session recording. Generating with limited data.");
  }

  // Get active decisions
  let activeDecisions: Array<import("../journal/types.js").Decision> = [];
  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const { DecisionStore } = await import("../journal/store.js");

    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (embedder) {
      const globalMgr = new GlobalMemoryManager();
      await globalMgr.init(embedder);
      const db = globalMgr.getDb();
      if (db) {
        const store = new DecisionStore();
        await store.init(db);
        const recent = await store.getRecentDecisions(30);
        activeDecisions = recent.filter((d) => d.status === "active");
      }
    }
  } catch {
    // Non-critical
  }

  const data = buildHandoffData({
    sessionId: targetSessionId,
    projectPath: process.cwd(),
    goal: session.goal || "Unknown goal",
    taskQueue: (finalState.task_queue ?? []) as Array<Record<string, unknown>>,
    nextSprintBacklog: (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>,
    promotedThisRun: (finalState.promoted_this_run ?? []) as string[],
    agentProfiles: (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>,
    activeDecisions,
    rfcDocument: (finalState.rfc_document as string) ?? null,
  });

  const markdown = renderContextMarkdown(data);

  if (preview) {
    console.log(markdown);
    return;
  }

  // Write to project directory
  const outPath = path.resolve(outputPath ?? DEFAULT_HANDOFF_CONFIG.outputPath);
  await writeFile(outPath, markdown, "utf-8");
  logger.success(`CONTEXT.md written to ${outPath}`);

  // Write timestamped copy to session dir
  const sessionDir = path.join(os.homedir(), ".openpawl", "sessions", targetSessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "CONTEXT.md"), markdown, "utf-8");

  // Git commit if enabled
  try {
    const { readGlobalConfigWithDefaults } = await import("../core/global-config.js");
    const cfg = readGlobalConfigWithDefaults() as Record<string, unknown>;
    const handoffCfg = cfg.handoff as Record<string, unknown> | undefined;
    if (handoffCfg?.gitCommit === true) {
      await gitCommitContext(outPath);
    }
  } catch {
    // Git commit is optional
  }
}

async function gitCommitContext(contextPath: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  try {
    // Check if in a git repo
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    execSync(`git add "${contextPath}"`, { stdio: "ignore" });
    execSync('git commit -m "chore: update OpenPawl context [auto]"', { stdio: "ignore" });
    logger.success("CONTEXT.md committed to git.");
  } catch {
    // Not a git repo or commit failed — silent
  }
}

async function handleImport(): Promise<void> {
  const contextPath = path.resolve("CONTEXT.md");

  if (!existsSync(contextPath)) {
    logger.error("No CONTEXT.md found in current directory.");
    return;
  }

  logger.info("Reading CONTEXT.md...");
  const { importContextFile } = await import("../handoff/importer.js");
  const result = await importContextFile(contextPath);

  if (!result) {
    logger.error("Failed to parse CONTEXT.md.");
    return;
  }

  if (result.imported > 0 || result.skipped > 0) {
    logger.success(`Imported ${result.imported} active decisions to journal`);
    if (result.skipped > 0) {
      logger.info(pc.dim(`(${result.skipped} already existed, ${result.imported} new)`));
    }
  }

  if (result.currentState.length > 0) {
    console.log(pc.bold("\nProject state:"));
    for (const state of result.currentState) {
      console.log(`  → ${state}`);
    }
  }

  if (result.leftToDo.length > 0) {
    console.log(pc.bold("\nLeft to do:"));
    for (const item of result.leftToDo) {
      console.log(`  → ${item}`);
    }
  }

  console.log(pc.green("\nReady. Run: openpawl work"));
}
```

- [ ] **Step 2: Add "handoff" to fuzzy matcher COMMANDS**

In `src/cli/fuzzy-matcher.ts`:
- Add `"handoff"` to the COMMANDS array (after `"think"`)
- Add `handoff: ["import"]` to SUBCOMMANDS

- [ ] **Step 3: Add handoff routing to cli.ts**

In `src/cli.ts`, add a new `else if` block before the final `else` (before line 385):
```typescript
} else if (cmd === "handoff") {
    const { runHandoffCommand } = await import("./commands/handoff.js");
    await runHandoffCommand(args.slice(1));
```

- [ ] **Step 4: Commit**

```bash
git add src/commands/handoff.ts src/cli/fuzzy-matcher.ts src/cli.ts
git commit -m "feat(handoff): add CLI command with generate, import, and preview"
```

---

## Task 9: Auto-Generation Trigger in Work Runner

**Files:**
- Modify: `src/work-runner.ts:1396-1399`

- [ ] **Step 1: Add auto-generation after audit export**

In `src/work-runner.ts`, after line 1399 (the `autoExportAudit` call), add:

```typescript
    // Auto-generate CONTEXT.md (async, non-blocking)
    if (lastFinalState) {
      autoGenerateContext(
        replaySessionId,
        goal,
        lastFinalState as Record<string, unknown>,
        workspacePath,
      ).catch(() => {});
    }
```

- [ ] **Step 2: Add the autoGenerateContext function**

Add this function near the `autoExportAudit` function (around line 153):

```typescript
/** Auto-generate CONTEXT.md after session completes. Never blocks. */
async function autoGenerateContext(
  sessionId: string,
  goal: string,
  finalState: Record<string, unknown>,
  workspacePath: string,
): Promise<void> {
  try {
    // Check config
    const { readGlobalConfigWithDefaults } = await import("./core/global-config.js");
    const cfg = readGlobalConfigWithDefaults() as Record<string, unknown>;
    const handoffCfg = cfg.handoff as Record<string, unknown> | undefined;
    if (handoffCfg?.autoGenerate === false) return;

    const { buildHandoffData } = await import("./handoff/collector.js");
    const { renderContextMarkdown } = await import("./handoff/renderer.js");
    const { DEFAULT_HANDOFF_CONFIG } = await import("./handoff/types.js");
    const { writeFile, mkdir } = await import("node:fs/promises");

    // Get active decisions (best-effort)
    let activeDecisions: import("./journal/types.js").Decision[] = [];
    try {
      const { DecisionStore } = await import("./journal/store.js");
      const { GlobalMemoryManager } = await import("./memory/global/store.js");
      const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
      await vm.init();
      const embedder = vm.getEmbedder();
      if (embedder) {
        const globalMgr = new GlobalMemoryManager();
        await globalMgr.init(embedder);
        const db = globalMgr.getDb();
        if (db) {
          const store = new DecisionStore();
          await store.init(db);
          const recent = await store.getRecentDecisions(30);
          activeDecisions = recent.filter((d) => d.status === "active");
        }
      }
    } catch {
      // Non-critical — continue without decisions
    }

    const data = buildHandoffData({
      sessionId,
      projectPath: workspacePath,
      goal,
      taskQueue: (finalState.task_queue ?? []) as Array<Record<string, unknown>>,
      nextSprintBacklog: (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>,
      promotedThisRun: (finalState.promoted_this_run ?? []) as string[],
      agentProfiles: (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>,
      activeDecisions,
      rfcDocument: (finalState.rfc_document as string) ?? null,
    });

    const markdown = renderContextMarkdown(data);

    // Write to project directory
    const outputPath = (handoffCfg?.outputPath as string) ?? DEFAULT_HANDOFF_CONFIG.outputPath;
    const projectContextPath = path.resolve(workspacePath, outputPath);
    await writeFile(projectContextPath, markdown, "utf-8");

    // Write timestamped copy to session dir
    const keepHistory = handoffCfg?.keepHistory !== false;
    if (keepHistory) {
      const sessionDir = path.join(os.homedir(), ".openpawl", "sessions", sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(path.join(sessionDir, "CONTEXT.md"), markdown, "utf-8");
    }

    // Git commit if enabled
    if (handoffCfg?.gitCommit === true) {
      try {
        const { execSync } = await import("node:child_process");
        execSync("git rev-parse --is-inside-work-tree", { cwd: workspacePath, stdio: "ignore" });
        execSync(`git add "${projectContextPath}"`, { cwd: workspacePath, stdio: "ignore" });
        execSync('git commit -m "chore: update OpenPawl context [auto]"', { cwd: workspacePath, stdio: "ignore" });
      } catch {
        // Git commit is optional — silent failure
      }
    }
  } catch {
    // Auto-generation failure should never affect the session
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/work-runner.ts
git commit -m "feat(handoff): auto-generate CONTEXT.md after session completes"
```

---

## Task 10: Briefing Integration

**Files:**
- Modify: `src/briefing/collector.ts:18-28`
- Modify: `src/briefing/types.ts` (add contextFileFound field)

- [ ] **Step 1: Add contextFileFound to BriefingData**

In `src/briefing/types.ts`, add to the BriefingData interface:
```typescript
contextFileFound?: boolean;
```

- [ ] **Step 2: Add CONTEXT.md detection to briefing collector**

In `src/briefing/collector.ts`, after the empty return check (line 33), add:

```typescript
  // Check for CONTEXT.md in cwd
  let contextFileFound = false;
  try {
    const { existsSync, statSync } = await import("node:fs");
    const contextPath = path.resolve("CONTEXT.md");
    if (existsSync(contextPath)) {
      const stat = statSync(contextPath);
      // Check if CONTEXT.md is newer than last session
      if (lastCompleted && stat.mtimeMs > lastCompleted.completedAt) {
        contextFileFound = true;
      }
    }
  } catch {
    // Non-critical
  }
```

Add `import path from "node:path";` to imports.

Add `contextFileFound` to the return object at line 203.

- [ ] **Step 3: Commit**

```bash
git add src/briefing/collector.ts src/briefing/types.ts
git commit -m "feat(handoff): detect CONTEXT.md in briefing collector"
```

---

## Task 11: Config Integration

**Files:**
- Modify: `src/core/global-config.ts:5-38`

- [ ] **Step 1: Add handoff to OpenPawlGlobalConfig interface**

In `src/core/global-config.ts`, add to the interface (after `proxy`):
```typescript
handoff?: {
  autoGenerate?: boolean;
  outputPath?: string;
  keepHistory?: boolean;
  gitCommit?: boolean;
};
```

- [ ] **Step 2: Add handoff parsing in normalizeGlobalConfig**

In `normalizeGlobalConfig()`, before the return (around line 206), add:
```typescript
const rawHandoff = (input as Record<string, unknown>).handoff;
const handoffObj = rawHandoff && typeof rawHandoff === "object" && !Array.isArray(rawHandoff)
  ? (rawHandoff as Record<string, unknown>)
  : undefined;
const handoff = handoffObj
  ? {
      autoGenerate: typeof handoffObj.autoGenerate === "boolean" ? handoffObj.autoGenerate : true,
      outputPath: typeof handoffObj.outputPath === "string" && handoffObj.outputPath.trim()
        ? handoffObj.outputPath.trim()
        : "./CONTEXT.md",
      keepHistory: typeof handoffObj.keepHistory === "boolean" ? handoffObj.keepHistory : true,
      gitCommit: typeof handoffObj.gitCommit === "boolean" ? handoffObj.gitCommit : false,
    }
  : undefined;
```

Add `...(handoff ? { handoff } : {})` to the return spread.

- [ ] **Step 3: Commit**

```bash
git add src/core/global-config.ts
git commit -m "feat(handoff): add handoff config to global config"
```

---

## Task 12: Web API Endpoints

**Files:**
- Modify: `src/web/server.ts`

- [ ] **Step 1: Add /api/handoff GET endpoint**

Add near the existing API endpoints (after think endpoints, before the closing section):

```typescript
// ─── Handoff Endpoints ────────────────────────────────────────────
fastify.get("/api/handoff", async (_req, reply) => {
  try {
    const { listSessions } = await import("../replay/session-index.js");
    const { readRecordingEvents } = await import("../replay/storage.js");
    const { buildHandoffData } = await import("../handoff/collector.js");

    const sessions = listSessions(5);
    const last = sessions.find((s) => s.completedAt > 0);
    if (!last) return reply.status(404).send({ error: "No completed sessions" });

    let finalState: Record<string, unknown> = {};
    try {
      const events = await readRecordingEvents(last.sessionId);
      const exitEvents = events.filter((e: Record<string, unknown>) => e.phase === "exit");
      const lastExit = exitEvents[exitEvents.length - 1] as Record<string, unknown> | undefined;
      finalState = (lastExit?.stateAfter ?? {}) as Record<string, unknown>;
    } catch { /* recording may be missing */ }

    // Get active decisions
    let activeDecisions: import("../journal/types.js").Decision[] = [];
    try {
      const { VectorMemory } = await import("../core/knowledge-base.js");
      const { CONFIG } = await import("../core/config.js");
      const { GlobalMemoryManager } = await import("../memory/global/store.js");
      const { DecisionStore } = await import("../journal/store.js");
      const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
      await vm.init();
      const embedder = vm.getEmbedder();
      if (embedder) {
        const globalMgr = new GlobalMemoryManager();
        await globalMgr.init(embedder);
        const db = globalMgr.getDb();
        if (db) {
          const store = new DecisionStore();
          await store.init(db);
          const recent = await store.getRecentDecisions(30);
          activeDecisions = recent.filter((d) => d.status === "active");
        }
      }
    } catch { /* non-critical */ }

    const data = buildHandoffData({
      sessionId: last.sessionId,
      projectPath: process.cwd(),
      goal: last.goal || "Unknown goal",
      taskQueue: (finalState.task_queue ?? []) as Array<Record<string, unknown>>,
      nextSprintBacklog: (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>,
      promotedThisRun: (finalState.promoted_this_run ?? []) as string[],
      agentProfiles: (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>,
      activeDecisions,
      rfcDocument: (finalState.rfc_document as string) ?? null,
    });

    return data;
  } catch (err) {
    return reply.status(500).send({ error: String(err) });
  }
});

fastify.post("/api/handoff/generate", async (_req, reply) => {
  try {
    const { listSessions } = await import("../replay/session-index.js");
    const { readRecordingEvents } = await import("../replay/storage.js");
    const { buildHandoffData } = await import("../handoff/collector.js");
    const { renderContextMarkdown } = await import("../handoff/renderer.js");
    const { DEFAULT_HANDOFF_CONFIG } = await import("../handoff/types.js");

    const sessions = listSessions(5);
    const last = sessions.find((s) => s.completedAt > 0);
    if (!last) return reply.status(404).send({ error: "No completed sessions" });

    let finalState: Record<string, unknown> = {};
    try {
      const events = await readRecordingEvents(last.sessionId);
      const exitEvents = events.filter((e: Record<string, unknown>) => e.phase === "exit");
      const lastExit = exitEvents[exitEvents.length - 1] as Record<string, unknown> | undefined;
      finalState = (lastExit?.stateAfter ?? {}) as Record<string, unknown>;
    } catch { /* */ }

    const data = buildHandoffData({
      sessionId: last.sessionId,
      projectPath: process.cwd(),
      goal: last.goal || "Unknown goal",
      taskQueue: (finalState.task_queue ?? []) as Array<Record<string, unknown>>,
      nextSprintBacklog: (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>,
      promotedThisRun: (finalState.promoted_this_run ?? []) as string[],
      agentProfiles: (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>,
      activeDecisions: [],
      rfcDocument: (finalState.rfc_document as string) ?? null,
    });

    const markdown = renderContextMarkdown(data);
    const outPath = path.resolve(DEFAULT_HANDOFF_CONFIG.outputPath);
    await writeFile(outPath, markdown, "utf-8");

    // Write session copy
    const sessionDir = path.join(os.homedir(), ".openpawl", "sessions", last.sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "CONTEXT.md"), markdown, "utf-8");

    return { path: outPath, markdown };
  } catch (err) {
    return reply.status(500).send({ error: String(err) });
  }
});

fastify.post("/api/handoff/import", async (_req, reply) => {
  try {
    const { importContextFile } = await import("../handoff/importer.js");
    const contextPath = path.resolve("CONTEXT.md");
    const result = await importContextFile(contextPath);
    if (!result) return reply.status(404).send({ error: "No CONTEXT.md found" });
    return result;
  } catch (err) {
    return reply.status(500).send({ error: String(err) });
  }
});
```

Note: Ensure `writeFile`, `mkdir`, `path`, `os` are already imported at the top of `server.ts`. The server already imports `path` and `os`. Add `writeFile` and `mkdir` from `"node:fs/promises"` if not present.

- [ ] **Step 2: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(handoff): add REST endpoints for handoff data and generation"
```

---

## Task 13: Dashboard HandoffPanel

**Files:**
- Create: `src/web/client/src/components/HandoffPanel.tsx`

- [ ] **Step 1: Write the panel component**

```tsx
// src/web/client/src/components/HandoffPanel.tsx
import { useState, useCallback } from "react";

interface HandoffData {
  generatedAt: number;
  sessionId: string;
  projectPath: string;
  completedGoal: string;
  sessionStatus: "complete" | "partial" | "failed";
  currentState: string[];
  activeDecisions: Array<{ decision: string; reasoning: string; recommendedBy: string; confidence: number }>;
  leftToDo: Array<{ description: string; type: string; priority: string }>;
  teamLearnings: string[];
  teamPerformance: Array<{ agentRole: string; note: string }>;
  resumeCommands: string[];
}

type PanelStatus = "idle" | "loading" | "loaded" | "generating" | "importing" | "error";

export function HandoffPanel() {
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [data, setData] = useState<HandoffData | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [message, setMessage] = useState<string>("");

  const loadData = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const resp = await fetch("/api/handoff");
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: "Failed to load" }));
        throw new Error((body as { error?: string }).error ?? "Failed to load");
      }
      const json = (await resp.json()) as HandoffData;
      setData(json);
      setStatus("loaded");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }, []);

  const generate = useCallback(async () => {
    setStatus("generating");
    setError("");
    setMessage("");
    try {
      const resp = await fetch("/api/handoff/generate", { method: "POST" });
      if (!resp.ok) throw new Error("Generation failed");
      const json = (await resp.json()) as { path: string; markdown: string };
      setMarkdown(json.markdown);
      setMessage(`Written to ${json.path}`);
      setStatus("loaded");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }, []);

  const handleImport = useCallback(async () => {
    setStatus("importing");
    setError("");
    setMessage("");
    try {
      const resp = await fetch("/api/handoff/import", { method: "POST" });
      if (!resp.ok) throw new Error("Import failed");
      const json = (await resp.json()) as { imported: number; skipped: number };
      setMessage(`Imported ${json.imported} decisions (${json.skipped} skipped)`);
      setStatus("loaded");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }, []);

  const download = useCallback(() => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "CONTEXT.md";
    a.click();
    URL.revokeObjectURL(url);
  }, [markdown]);

  return (
    <div style={{ padding: "1rem" }}>
      <h2 style={{ marginBottom: "1rem" }}>Context Handoff</h2>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button onClick={loadData} disabled={status === "loading"}>
          {status === "loading" ? "Loading..." : "Load Current"}
        </button>
        <button onClick={generate} disabled={status === "generating"}>
          {status === "generating" ? "Generating..." : "Generate CONTEXT.md"}
        </button>
        <button onClick={handleImport} disabled={status === "importing"}>
          {status === "importing" ? "Importing..." : "Import"}
        </button>
        {markdown && <button onClick={download}>Download</button>}
      </div>

      {error && (
        <div style={{ color: "#ef4444", marginBottom: "1rem" }}>{error}</div>
      )}
      {message && (
        <div style={{ color: "#22c55e", marginBottom: "1rem" }}>{message}</div>
      )}

      {data && (
        <div style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>
          <div style={{ marginBottom: "0.75rem" }}>
            <strong>Session:</strong> {data.sessionId}<br />
            <strong>Goal:</strong> {data.completedGoal}<br />
            <strong>Status:</strong> {data.sessionStatus === "complete" ? "✅" : data.sessionStatus === "failed" ? "❌" : "⚠️"} {data.sessionStatus}
          </div>

          {data.currentState.length > 0 && (
            <div style={{ marginBottom: "0.75rem" }}>
              <strong>Current State:</strong>
              <ul style={{ margin: "0.25rem 0", paddingLeft: "1.5rem" }}>
                {data.currentState.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {data.leftToDo.length > 0 && (
            <div style={{ marginBottom: "0.75rem" }}>
              <strong>Left To Do:</strong>
              <ul style={{ margin: "0.25rem 0", paddingLeft: "1.5rem" }}>
                {data.leftToDo.map((item, i) => (
                  <li key={i}>{item.description} <span style={{ color: "#94a3b8" }}>({item.type})</span></li>
                ))}
              </ul>
            </div>
          )}

          {data.resumeCommands.length > 0 && (
            <div style={{ marginBottom: "0.75rem" }}>
              <strong>Resume Commands:</strong>
              <pre style={{ background: "#1e293b", padding: "0.5rem", borderRadius: "4px", overflow: "auto" }}>
                {data.resumeCommands.join("\n")}
              </pre>
            </div>
          )}
        </div>
      )}

      {markdown && (
        <details style={{ marginTop: "1rem" }}>
          <summary style={{ cursor: "pointer" }}>Preview CONTEXT.md</summary>
          <pre style={{ background: "#0f172a", padding: "1rem", borderRadius: "4px", overflow: "auto", maxHeight: "400px", fontSize: "0.8rem" }}>
            {markdown}
          </pre>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/client/src/components/HandoffPanel.tsx
git commit -m "feat(handoff): add dashboard HandoffPanel component"
```

---

## Task 14: Add handoff to CLI help text

**Files:**
- Modify: `src/cli.ts:53-108` (help text)

- [ ] **Step 1: Add handoff line to help output**

In the `printHelp()` function, add a new command line after the `journal` entry (around line 89):

```typescript
"  " + cmd(pad("handoff")) + desc("Generate CONTEXT.md handoff file, or import from collaborator"),
```

- [ ] **Step 2: Commit**

```bash
git add src/cli.ts
git commit -m "feat(handoff): add handoff to CLI help text"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 2: Run all handoff tests**

Run: `bun run test -- tests/handoff-`
Expected: ALL PASS

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: ALL PASS (no regressions)

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 5: Final commit if any fixes needed**

Fix any typecheck/lint issues, then commit.

- [ ] **Step 6: Commit and push**

```bash
git push origin staging
```
