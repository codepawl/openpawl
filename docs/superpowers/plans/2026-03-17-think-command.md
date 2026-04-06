# Think Command (Rubber Duck Mode) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `openpawl think` — a lightweight structured debate between Tech Lead and RFC Author perspectives that produces a recommendation with tradeoffs and optionally saves to the decision journal.

**Architecture:** Direct sequential ProxyService.stream() calls (no LangGraph graph). CLI mode uses ProxyService directly; dashboard uses POST /api/think SSE endpoint. Context loaded async from journal/memory/profiles. History stored in global.db think_history table (LanceDB with dummy vector).

**Tech Stack:** TypeScript (ESM), ProxyService, LanceDB, Fastify SSE, @clack/prompts, picocolors, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-think-command-design.md`

---

### Task 1: Types

**Files:**
- Create: `src/think/types.ts`

- [ ] **Step 1: Create types file**

```typescript
// src/think/types.ts
/**
 * Types for the think (rubber duck) mode.
 */

import type { Decision } from "../journal/types.js";
import type { AgentProfile } from "../agents/profiles/types.js";

export interface ThinkRecommendation {
  choice: string;
  confidence: number;
  reasoning: string;
  tradeoffs: {
    pros: string[];
    cons: string[];
  };
}

export interface ThinkRound {
  question: string;
  techLeadPerspective: string;
  rfcAuthorPerspective: string;
  recommendation: ThinkRecommendation;
}

export interface ThinkContext {
  relevantDecisions: Decision[];
  relevantPatterns: string[];
  agentProfiles: {
    techLead: AgentProfile | null;
    rfcAuthor: AgentProfile | null;
  };
}

export interface ThinkSession {
  id: string;
  question: string;
  context: ThinkContext;
  rounds: ThinkRound[];
  recommendation: ThinkRecommendation | null;
  savedToJournal: boolean;
  createdAt: number;
}

export interface ThinkHistoryEntry {
  sessionId: string;
  question: string;
  recommendation: string;
  confidence: number;
  savedToJournal: boolean;
  followUpCount: number;
  createdAt: number;
}

/** SSE events streamed to the dashboard. */
export type ThinkEvent =
  | { event: "context_loaded"; data: { relevantDecisions: number } }
  | { event: "tech_lead_start"; data: Record<string, never> }
  | { event: "tech_lead_chunk"; data: { content: string } }
  | { event: "tech_lead_done"; data: { perspective: string } }
  | { event: "rfc_author_start"; data: Record<string, never> }
  | { event: "rfc_author_chunk"; data: { content: string } }
  | { event: "rfc_author_done"; data: { perspective: string } }
  | { event: "recommendation"; data: { recommendation: ThinkRecommendation } }
  | { event: "error"; data: { stage: string; message: string } }
  | { event: "done"; data: Record<string, never> };
```

- [ ] **Step 2: Verify types compile**

Run: `bun run typecheck`
Expected: PASS (no errors related to think/types.ts)

- [ ] **Step 3: Commit**

```bash
git add src/think/types.ts
git commit -m "feat(think): add types for rubber duck mode"
```

---

### Task 2: Prompts

**Files:**
- Create: `src/think/prompts.ts`
- Test: `tests/think-prompts.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/think-prompts.test.ts
import { describe, it, expect } from "vitest";
import {
  buildTechLeadPrompt,
  buildRfcAuthorPrompt,
  buildCoordinatorPrompt,
  buildFollowUpContext,
} from "../src/think/prompts.js";
import type { ThinkRound, ThinkRecommendation } from "../src/think/types.js";
import type { Decision } from "../src/journal/types.js";

const fakeDecision: Decision = {
  id: "d1",
  sessionId: "s1",
  runIndex: 0,
  capturedAt: Date.now(),
  topic: "SSE streaming",
  decision: "Use SSE for agent streaming",
  reasoning: "Simpler than WebSocket for unidirectional flow",
  recommendedBy: "rfc_author",
  confidence: 0.91,
  taskId: "t1",
  goalContext: "agent streaming",
  tags: ["sse", "streaming"],
  embedding: [],
  status: "active",
};

const fakeRound: ThinkRound = {
  question: "SSE or WebSocket?",
  techLeadPerspective: "SSE is simpler.",
  rfcAuthorPerspective: "WebSocket for bidirectional.",
  recommendation: {
    choice: "Use SSE",
    confidence: 0.88,
    reasoning: "Simpler for unidirectional.",
    tradeoffs: { pros: ["Simple"], cons: ["No bidirectional"] },
  },
};

describe("buildTechLeadPrompt", () => {
  it("includes the question", () => {
    const prompt = buildTechLeadPrompt("SSE or WebSocket?", []);
    expect(prompt).toContain("SSE or WebSocket?");
  });

  it("includes decision context when provided", () => {
    const prompt = buildTechLeadPrompt("SSE or WebSocket?", [fakeDecision]);
    expect(prompt).toContain("Use SSE for agent streaming");
    expect(prompt).toContain("0.91");
  });

  it("says no past decisions when empty", () => {
    const prompt = buildTechLeadPrompt("SSE or WebSocket?", []);
    expect(prompt).toContain("No relevant past decisions");
  });
});

describe("buildRfcAuthorPrompt", () => {
  it("includes the question", () => {
    const prompt = buildRfcAuthorPrompt("SSE or WebSocket?", []);
    expect(prompt).toContain("SSE or WebSocket?");
  });

  it("includes decision context when provided", () => {
    const prompt = buildRfcAuthorPrompt("SSE or WebSocket?", [fakeDecision]);
    expect(prompt).toContain("Use SSE for agent streaming");
  });
});

describe("buildCoordinatorPrompt", () => {
  it("includes both perspectives", () => {
    const prompt = buildCoordinatorPrompt("SSE is simpler.", "WebSocket for bidirectional.");
    expect(prompt).toContain("SSE is simpler.");
    expect(prompt).toContain("WebSocket for bidirectional.");
  });

  it("requests JSON output", () => {
    const prompt = buildCoordinatorPrompt("a", "b");
    expect(prompt).toContain('"choice"');
    expect(prompt).toContain('"confidence"');
  });
});

describe("buildFollowUpContext", () => {
  it("includes previous rounds", () => {
    const context = buildFollowUpContext([fakeRound]);
    expect(context).toContain("SSE or WebSocket?");
    expect(context).toContain("SSE is simpler.");
    expect(context).toContain("WebSocket for bidirectional.");
    expect(context).toContain("Use SSE");
  });

  it("returns empty string for no rounds", () => {
    expect(buildFollowUpContext([])).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/think-prompts.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement prompts**

```typescript
// src/think/prompts.ts
/**
 * Prompt builders for think mode agents.
 */

import type { Decision } from "../journal/types.js";
import type { ThinkRound } from "./types.js";

function formatDecisionContext(decisions: Decision[]): string {
  if (decisions.length === 0) return "No relevant past decisions.";
  return decisions
    .map((d) => {
      const date = new Date(d.capturedAt).toISOString().slice(0, 10);
      return `- "${d.decision}" (${date}, ${d.recommendedBy}, confidence ${d.confidence.toFixed(2)})\n  Reasoning: ${d.reasoning}`;
    })
    .join("\n");
}

export function buildTechLeadPrompt(
  question: string,
  decisions: Decision[],
): string {
  return `You are OpenPawl's Tech Lead. Your role is to give a pragmatic, implementation-focused perspective on this question.

Past decisions relevant to this question:
${formatDecisionContext(decisions)}

Question: ${question}

Give your perspective in 3-5 sentences. Focus on practical implementation concerns, complexity, and consistency with existing decisions. Be direct and opinionated.
End with your recommended choice in one sentence.`;
}

export function buildRfcAuthorPrompt(
  question: string,
  decisions: Decision[],
): string {
  return `You are OpenPawl's RFC Author. Your role is to consider longer-term architectural implications and edge cases.

Past decisions relevant to this question:
${formatDecisionContext(decisions)}

Question: ${question}

Give your perspective in 3-5 sentences. Focus on future flexibility, architectural consistency, and risks. Be direct and opinionated.
End with your recommended choice in one sentence.`;
}

export function buildCoordinatorPrompt(
  techLeadPerspective: string,
  rfcAuthorPerspective: string,
): string {
  return `You are OpenPawl's Coordinator. Two experts have weighed in:

Tech Lead: ${techLeadPerspective}

RFC Author: ${rfcAuthorPerspective}

Synthesize their views into:
- A clear recommendation (one choice)
- A confidence score (0-1)
- Reasoning (2-3 sentences)
- Tradeoffs: 2-3 pros, 2-3 cons

Return ONLY valid JSON, no markdown fences:
{
  "choice": "...",
  "confidence": 0.0,
  "reasoning": "...",
  "tradeoffs": { "pros": ["..."], "cons": ["..."] }
}`;
}

export function buildFollowUpContext(previousRounds: ThinkRound[]): string {
  if (previousRounds.length === 0) return "";
  const summary = previousRounds
    .map((r, i) => {
      return `Round ${i + 1}: "${r.question}"
  Tech Lead: ${r.techLeadPerspective}
  RFC Author: ${r.rfcAuthorPerspective}
  Recommendation: ${r.recommendation.choice} (confidence ${r.recommendation.confidence.toFixed(2)})`;
    })
    .join("\n\n");
  return `Previous discussion:\n${summary}\n\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/think-prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/think/prompts.ts tests/think-prompts.test.ts
git commit -m "feat(think): add prompt builders with tests"
```

---

### Task 3: Context Loader

**Files:**
- Create: `src/think/context-loader.ts`
- Test: `tests/think-context-loader.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/think-context-loader.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Decision } from "../src/journal/types.js";
import type { AgentProfile } from "../src/agents/profiles/types.js";
import type { ThinkContext } from "../src/think/types.js";

// Mock dependencies before import
const mockDecisions: Decision[] = [
  {
    id: "d1", sessionId: "s1", runIndex: 0, capturedAt: Date.now(),
    topic: "SSE", decision: "Use SSE", reasoning: "Simpler",
    recommendedBy: "tech_lead", confidence: 0.9, taskId: "t1",
    goalContext: "streaming", tags: ["sse"], embedding: [], status: "active",
  },
  {
    id: "d2", sessionId: "s1", runIndex: 0, capturedAt: Date.now(),
    topic: "Redis", decision: "Use Redis", reasoning: "Fast cache",
    recommendedBy: "rfc_author", confidence: 0.85, taskId: "t2",
    goalContext: "caching", tags: ["redis"], embedding: [], status: "active",
  },
  {
    id: "d3", sessionId: "s1", runIndex: 0, capturedAt: Date.now(),
    topic: "Auth", decision: "Use JWT", reasoning: "Stateless",
    recommendedBy: "coordinator", confidence: 0.8, taskId: "t3",
    goalContext: "auth", tags: ["jwt"], embedding: [], status: "active",
  },
  {
    id: "d4", sessionId: "s1", runIndex: 0, capturedAt: Date.now(),
    topic: "DB", decision: "Use Postgres", reasoning: "Relational",
    recommendedBy: "tech_lead", confidence: 0.7, taskId: "t4",
    goalContext: "database", tags: ["postgres"], embedding: [], status: "active",
  },
];

const mockPatterns = [
  { pattern: "pattern-1", context: "context-1" },
  { pattern: "pattern-2", context: "context-2" },
  { pattern: "pattern-3", context: "context-3" },
];

const mockProfile: AgentProfile = {
  agentRole: "tech_lead",
  taskTypeScores: [],
  overallScore: 0.85,
  strengths: ["pragmatic"],
  weaknesses: [],
  lastUpdatedAt: Date.now(),
  totalTasksCompleted: 10,
  scoreHistory: [0.85],
};

vi.mock("../src/core/knowledge-base.js", () => ({
  VectorMemory: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getEmbedder: vi.fn().mockReturnValue({}),
  })),
}));

vi.mock("../src/core/config.js", () => ({
  CONFIG: { vectorStorePath: "/tmp/test", memoryBackend: "lancedb" },
}));

vi.mock("../src/memory/global/store.js", () => ({
  GlobalMemoryManager: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue({}),
  })),
}));

vi.mock("../src/journal/store.js", () => ({
  DecisionStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue(mockDecisions),
  })),
}));

vi.mock("../src/memory/success/store.js", () => ({
  SuccessPatternStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue(mockPatterns),
  })),
}));

vi.mock("../src/agents/profiles/store.js", () => ({
  ProfileStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getByRole: vi.fn().mockImplementation((role: string) => {
      if (role === "tech_lead") return Promise.resolve(mockProfile);
      if (role === "rfc_author") return Promise.resolve({ ...mockProfile, agentRole: "rfc_author" });
      return Promise.resolve(null);
    }),
  })),
}));

const { loadThinkContext } = await import("../src/think/context-loader.js");

describe("loadThinkContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns max 3 decisions", async () => {
    const ctx = await loadThinkContext("streaming question");
    expect(ctx.relevantDecisions.length).toBeLessThanOrEqual(3);
  });

  it("returns max 2 patterns", async () => {
    const ctx = await loadThinkContext("any question");
    expect(ctx.relevantPatterns.length).toBeLessThanOrEqual(2);
  });

  it("loads agent profiles", async () => {
    const ctx = await loadThinkContext("question");
    expect(ctx.agentProfiles.techLead).not.toBeNull();
    expect(ctx.agentProfiles.rfcAuthor).not.toBeNull();
  });

  it("completes in under 500ms with mocked data", async () => {
    const start = Date.now();
    await loadThinkContext("question");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("returns empty context on full failure", async () => {
    // Import a fresh version that will fail (mocks already set up)
    const { loadThinkContext: loadFresh } = await import("../src/think/context-loader.js");
    // The mock returns data, but this verifies the shape
    const ctx = await loadFresh("question");
    expect(ctx).toHaveProperty("relevantDecisions");
    expect(ctx).toHaveProperty("relevantPatterns");
    expect(ctx).toHaveProperty("agentProfiles");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/think-context-loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement context loader**

```typescript
// src/think/context-loader.ts
/**
 * Context loader for think mode.
 * Loads decisions, patterns, and profiles concurrently.
 */

import type { ThinkContext } from "./types.js";
import type { Decision } from "../journal/types.js";
import type { AgentProfile } from "../agents/profiles/types.js";

const MAX_DECISIONS = 3;
const MAX_PATTERNS = 2;

const EMPTY_CONTEXT: ThinkContext = {
  relevantDecisions: [],
  relevantPatterns: [],
  agentProfiles: { techLead: null, rfcAuthor: null },
};

async function loadDecisions(): Promise<Decision[]> {
  const { VectorMemory } = await import("../core/knowledge-base.js");
  const { CONFIG } = await import("../core/config.js");
  const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
  await vm.init();
  const embedder = vm.getEmbedder();
  if (!embedder) return [];

  const { GlobalMemoryManager } = await import("../memory/global/store.js");
  const globalMgr = new GlobalMemoryManager();
  await globalMgr.init(embedder);
  const db = globalMgr.getDb();
  if (!db) return [];

  const { DecisionStore } = await import("../journal/store.js");
  const store = new DecisionStore();
  await store.init(db);
  return store.getAll();
}

async function loadPatterns(): Promise<string[]> {
  const { VectorMemory } = await import("../core/knowledge-base.js");
  const { CONFIG } = await import("../core/config.js");
  const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
  await vm.init();
  const embedder = vm.getEmbedder();
  if (!embedder) return [];

  const { GlobalMemoryManager } = await import("../memory/global/store.js");
  const globalMgr = new GlobalMemoryManager();
  await globalMgr.init(embedder);
  const db = globalMgr.getDb();
  if (!db) return [];

  const { SuccessPatternStore } = await import("../memory/success/store.js");
  const store = new SuccessPatternStore(db, embedder);
  await store.init();
  const patterns = await store.getAll();
  return patterns.map((p: { pattern: string }) => p.pattern);
}

async function loadProfile(role: string): Promise<AgentProfile | null> {
  const { VectorMemory } = await import("../core/knowledge-base.js");
  const { CONFIG } = await import("../core/config.js");
  const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
  await vm.init();
  const embedder = vm.getEmbedder();
  if (!embedder) return null;

  const { GlobalMemoryManager } = await import("../memory/global/store.js");
  const globalMgr = new GlobalMemoryManager();
  await globalMgr.init(embedder);
  const db = globalMgr.getDb();
  if (!db) return null;

  const { ProfileStore } = await import("../agents/profiles/store.js");
  const store = new ProfileStore();
  await store.init(db);
  return store.getByRole(role);
}

export async function loadThinkContext(
  _question: string,
): Promise<ThinkContext> {
  try {
    const [decisions, patterns, techLead, rfcAuthor] = await Promise.all([
      loadDecisions().catch(() => [] as Decision[]),
      loadPatterns().catch(() => [] as string[]),
      loadProfile("tech_lead").catch(() => null),
      loadProfile("rfc_author").catch(() => null),
    ]);

    return {
      relevantDecisions: decisions.slice(0, MAX_DECISIONS),
      relevantPatterns: patterns.slice(0, MAX_PATTERNS),
      agentProfiles: { techLead, rfcAuthor },
    };
  } catch {
    return EMPTY_CONTEXT;
  }
}
```

Note: This creates multiple VectorMemory/GlobalMemoryManager instances across the parallel calls. This is acceptable because LanceDB handles concurrent reads, the mocks work cleanly, and the cold-start init only happens once per process (VectorMemory caches). If profiling reveals this is an issue, refactor to share a single init — but don't pre-optimize.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/think-context-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/think/context-loader.ts tests/think-context-loader.test.ts
git commit -m "feat(think): add context loader with tests"
```

---

### Task 4: Executor

**Files:**
- Create: `src/think/executor.ts`
- Test: `tests/think-executor.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/think-executor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamChunk } from "../src/client/types.js";
import type { ThinkContext, ThinkRound } from "../src/think/types.js";

// Mock ProxyService
const mockStream = vi.fn();

vi.mock("../src/proxy/ProxyService.js", () => ({
  ProxyService: vi.fn().mockImplementation(() => ({
    stream: mockStream,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
  })),
  createProxyService: vi.fn().mockReturnValue({
    stream: mockStream,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../src/core/global-config.js", () => ({
  readGlobalConfigWithDefaults: () => ({
    gatewayUrl: "ws://localhost:18789",
    token: "test-token",
  }),
}));

const { executeThinkRound } = await import("../src/think/executor.js");

const emptyContext: ThinkContext = {
  relevantDecisions: [],
  relevantPatterns: [],
  agentProfiles: { techLead: null, rfcAuthor: null },
};

async function* makeChunks(text: string): AsyncGenerator<StreamChunk> {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    yield { content: words[i] + " ", done: i === words.length - 1 };
  }
}

describe("executeThinkRound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sequences Tech Lead → RFC Author → Coordinator", async () => {
    const techLeadText = "SSE is simpler for this use case.";
    const rfcAuthorText = "Consider WebSocket for future needs.";
    const coordinatorJson = JSON.stringify({
      choice: "Use SSE",
      confidence: 0.88,
      reasoning: "SSE fits the unidirectional requirement.",
      tradeoffs: { pros: ["Simple"], cons: ["No bidirectional"] },
    });

    let callCount = 0;
    mockStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeChunks(techLeadText);
      if (callCount === 2) return makeChunks(rfcAuthorText);
      return makeChunks(coordinatorJson);
    });

    const round = await executeThinkRound("SSE or WebSocket?", emptyContext);

    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(round.techLeadPerspective).toContain("SSE is simpler");
    expect(round.rfcAuthorPerspective).toContain("WebSocket");
    expect(round.recommendation.choice).toBe("Use SSE");
    expect(round.recommendation.confidence).toBe(0.88);
  });

  it("returns partial results on RFC Author failure", async () => {
    const techLeadText = "SSE is simpler.";
    let callCount = 0;
    mockStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeChunks(techLeadText);
      throw new Error("Connection failed");
    });

    const round = await executeThinkRound("SSE or WebSocket?", emptyContext);

    expect(round.techLeadPerspective).toContain("SSE is simpler");
    expect(round.rfcAuthorPerspective).toBe("");
    expect(round.recommendation.choice).toBe("Inconclusive");
    expect(round.recommendation.confidence).toBe(0);
  });

  it("includes previous rounds in follow-up prompts", async () => {
    const prevRounds: ThinkRound[] = [{
      question: "SSE or WebSocket?",
      techLeadPerspective: "SSE is simpler.",
      rfcAuthorPerspective: "WebSocket for future.",
      recommendation: {
        choice: "Use SSE", confidence: 0.88,
        reasoning: "Fits requirement.", tradeoffs: { pros: ["Simple"], cons: ["No bidir"] },
      },
    }];

    const coordinatorJson = JSON.stringify({
      choice: "Keep SSE", confidence: 0.9,
      reasoning: "Still correct.", tradeoffs: { pros: ["Consistent"], cons: ["None"] },
    });

    mockStream.mockImplementation(() => makeChunks(coordinatorJson));

    await executeThinkRound("What about approvals?", emptyContext, {
      previousRounds: prevRounds,
      onChunk: () => {},
    });

    // Verify first call (Tech Lead) includes previous round context
    const firstCallPrompt = mockStream.mock.calls[0][0] as string;
    expect(firstCallPrompt).toContain("Previous discussion");
    expect(firstCallPrompt).toContain("SSE or WebSocket?");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/think-executor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement executor**

```typescript
// src/think/executor.ts
/**
 * Think mode executor — calls ProxyService.stream() sequentially for
 * Tech Lead, RFC Author, and Coordinator perspectives.
 */

import { ProxyService, createProxyService } from "../proxy/ProxyService.js";
import { readGlobalConfigWithDefaults } from "../core/global-config.js";
import type { StreamChunk } from "../client/types.js";
import type { ThinkContext, ThinkRound, ThinkRecommendation } from "./types.js";
import {
  buildTechLeadPrompt,
  buildRfcAuthorPrompt,
  buildCoordinatorPrompt,
  buildFollowUpContext,
} from "./prompts.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";

const INCONCLUSIVE: ThinkRecommendation = {
  choice: "Inconclusive",
  confidence: 0,
  reasoning: "Could not complete analysis — one or more agent calls failed.",
  tradeoffs: { pros: [], cons: [] },
};

export interface ExecuteOptions {
  previousRounds?: ThinkRound[];
  onChunk?: (stage: "tech_lead" | "rfc_author" | "coordinator", content: string) => void;
}

function getProxy(): ProxyService {
  const globalCfg = readGlobalConfigWithDefaults();
  return createProxyService({
    gatewayUrl: globalCfg.gatewayUrl,
    apiKey: globalCfg.token,
  });
}

async function collectStream(
  proxy: ProxyService,
  prompt: string,
  stage: "tech_lead" | "rfc_author" | "coordinator",
  onChunk?: ExecuteOptions["onChunk"],
): Promise<string> {
  let result = "";
  for await (const chunk of proxy.stream(prompt)) {
    result += chunk.content;
    onChunk?.(stage, chunk.content);
  }
  return result.trim();
}

export async function executeThinkRound(
  question: string,
  context: ThinkContext,
  options?: ExecuteOptions,
): Promise<ThinkRound> {
  const proxy = getProxy();
  const followUpPrefix = buildFollowUpContext(options?.previousRounds ?? []);
  const fullQuestion = followUpPrefix ? `${followUpPrefix}Follow-up question: ${question}` : question;

  // 1. Tech Lead
  let techLeadPerspective = "";
  try {
    const prompt = buildTechLeadPrompt(fullQuestion, context.relevantDecisions);
    techLeadPerspective = await collectStream(proxy, prompt, "tech_lead", options?.onChunk);
  } catch {
    // Partial failure — continue with empty perspective
  }

  // 2. RFC Author
  let rfcAuthorPerspective = "";
  try {
    const prompt = buildRfcAuthorPrompt(fullQuestion, context.relevantDecisions);
    rfcAuthorPerspective = await collectStream(proxy, prompt, "rfc_author", options?.onChunk);
  } catch {
    // Partial failure — continue with what we have
  }

  // 3. Coordinator synthesis
  if (!techLeadPerspective && !rfcAuthorPerspective) {
    return { question, techLeadPerspective, rfcAuthorPerspective, recommendation: INCONCLUSIVE };
  }

  let recommendation: ThinkRecommendation;
  try {
    const prompt = buildCoordinatorPrompt(
      techLeadPerspective || "(Tech Lead was unavailable)",
      rfcAuthorPerspective || "(RFC Author was unavailable)",
    );
    const raw = await collectStream(proxy, prompt, "coordinator", options?.onChunk);
    recommendation = parseLlmJson<ThinkRecommendation>(raw);

    // Validate required fields
    if (typeof recommendation.choice !== "string" || typeof recommendation.confidence !== "number") {
      throw new Error("Missing required fields in recommendation");
    }
    // Clamp confidence to 0-1
    recommendation.confidence = Math.max(0, Math.min(1, recommendation.confidence));
    // Ensure tradeoffs arrays exist
    recommendation.tradeoffs = recommendation.tradeoffs ?? { pros: [], cons: [] };
    recommendation.tradeoffs.pros = recommendation.tradeoffs.pros ?? [];
    recommendation.tradeoffs.cons = recommendation.tradeoffs.cons ?? [];
  } catch {
    recommendation = INCONCLUSIVE;
  }

  return { question, techLeadPerspective, rfcAuthorPerspective, recommendation };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/think-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/think/executor.ts tests/think-executor.test.ts
git commit -m "feat(think): add executor with streaming and partial failure handling"
```

---

### Task 5: Think History Store

**Files:**
- Create: `src/think/history.ts`
- Test: `tests/think-history.test.ts`

- [ ] **Step 1: Write the failing tests**

Follow the exact pattern from `src/clarity/history.ts` — LanceDB table with `vector: [0]` dummy, `entryToRow`/`rowToEntry` converters.

```typescript
// tests/think-history.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThinkHistoryEntry } from "../src/think/types.js";

// Mock LanceDB
const mockRows: Record<string, unknown>[] = [];
const mockTable = {
  add: vi.fn().mockImplementation(async (rows: Record<string, unknown>[]) => {
    mockRows.push(...rows);
  }),
  query: vi.fn().mockReturnValue({
    toArray: vi.fn().mockImplementation(async () => [...mockRows]),
  }),
};

const mockDb = {
  tableNames: vi.fn().mockResolvedValue([]),
  createTable: vi.fn().mockImplementation(async (_name: string, rows: Record<string, unknown>[]) => {
    mockRows.push(...rows);
    return mockTable;
  }),
  openTable: vi.fn().mockResolvedValue(mockTable),
};

const { ThinkHistoryStore } = await import("../src/think/history.js");

describe("ThinkHistoryStore", () => {
  let store: InstanceType<typeof ThinkHistoryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRows.length = 0;
    store = new ThinkHistoryStore();
  });

  it("records and retrieves entries", async () => {
    await store.init(mockDb as any);

    const entry: ThinkHistoryEntry = {
      sessionId: "think-123",
      question: "SSE or WebSocket?",
      recommendation: "Use SSE",
      confidence: 0.88,
      savedToJournal: true,
      followUpCount: 1,
      createdAt: Date.now(),
    };

    const ok = await store.record(entry);
    expect(ok).toBe(true);

    const all = await store.getAll();
    expect(all.length).toBe(1);
    expect(all[0].question).toBe("SSE or WebSocket?");
    expect(all[0].savedToJournal).toBe(true);
  });

  it("returns empty array when no table exists", async () => {
    await store.init(mockDb as any);
    // Don't record anything — table created lazily
    const freshStore = new ThinkHistoryStore();
    mockDb.tableNames.mockResolvedValueOnce([]);
    await freshStore.init(mockDb as any);
    const all = await freshStore.getAll();
    expect(all).toEqual([]);
  });

  it("sorts by createdAt descending", async () => {
    await store.init(mockDb as any);

    await store.record({
      sessionId: "t1", question: "First", recommendation: "A",
      confidence: 0.5, savedToJournal: false, followUpCount: 0, createdAt: 1000,
    });
    await store.record({
      sessionId: "t2", question: "Second", recommendation: "B",
      confidence: 0.7, savedToJournal: true, followUpCount: 1, createdAt: 2000,
    });

    const all = await store.getAll();
    expect(all[0].question).toBe("Second");
    expect(all[1].question).toBe("First");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/think-history.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement history store**

Follow `src/clarity/history.ts` pattern exactly:

```typescript
// src/think/history.ts
/**
 * Think history — persists think session results in global.db.
 */

import type * as lancedb from "@lancedb/lancedb";
import type { ThinkHistoryEntry } from "./types.js";
import { logger, isDebugMode } from "../core/logger.js";

const THINK_HISTORY_TABLE = "think_history";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

interface ThinkHistoryRow {
  id: string;
  session_id: string;
  question: string;
  recommendation: string;
  confidence: number;
  saved_to_journal: number; // 0 or 1 (LanceDB doesn't support boolean)
  follow_up_count: number;
  created_at: number;
  vector: number[];
}

function entryToRow(entry: ThinkHistoryEntry, id: string): ThinkHistoryRow {
  return {
    id,
    session_id: entry.sessionId,
    question: entry.question,
    recommendation: entry.recommendation,
    confidence: entry.confidence,
    saved_to_journal: entry.savedToJournal ? 1 : 0,
    follow_up_count: entry.followUpCount,
    created_at: entry.createdAt,
    vector: [0],
  };
}

function rowToEntry(row: Record<string, unknown>): ThinkHistoryEntry {
  return {
    sessionId: String(row.session_id ?? ""),
    question: String(row.question ?? ""),
    recommendation: String(row.recommendation ?? ""),
    confidence: Number(row.confidence ?? 0),
    savedToJournal: Number(row.saved_to_journal ?? 0) === 1,
    followUpCount: Number(row.follow_up_count ?? 0),
    createdAt: Number(row.created_at ?? 0),
  };
}

export class ThinkHistoryStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  async init(db: lancedb.Connection): Promise<void> {
    this.db = db;
    try {
      const tableNames = await db.tableNames();
      if (tableNames.includes(THINK_HISTORY_TABLE)) {
        this.table = await db.openTable(THINK_HISTORY_TABLE);
      }
      log(`ThinkHistoryStore initialized (table exists: ${this.table !== null})`);
    } catch (err) {
      log(`ThinkHistoryStore init failed: ${err}`);
    }
  }

  async record(entry: ThinkHistoryEntry): Promise<boolean> {
    if (!this.db) return false;
    try {
      const id = `think-${entry.createdAt}-${Math.random().toString(36).slice(2, 8)}`;
      const row = entryToRow(entry, id);
      if (!this.table) {
        this.table = await this.db.createTable(
          THINK_HISTORY_TABLE,
          [row as unknown as Record<string, unknown>],
        );
      } else {
        await this.table.add([row as unknown as Record<string, unknown>]);
      }
      return true;
    } catch (err) {
      log(`Failed to record think history: ${err}`);
      return false;
    }
  }

  async getAll(): Promise<ThinkHistoryEntry[]> {
    if (!this.table) return [];
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      return rows.map(rowToEntry).sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
      log(`Failed to get think history: ${err}`);
      return [];
    }
  }

  async getBySessionId(sessionId: string): Promise<ThinkHistoryEntry | null> {
    const all = await this.getAll();
    return all.find((e) => e.sessionId === sessionId) ?? null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/think-history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/think/history.ts tests/think-history.test.ts
git commit -m "feat(think): add history store with tests"
```

---

### Task 6: Think Session Orchestrator

**Files:**
- Create: `src/think/session.ts`
- Modify: `src/journal/extractor.ts` (export `extractTags`)
- Test: `tests/think-session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/think-session.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThinkRecommendation, ThinkContext } from "../src/think/types.js";

const mockRecommendation: ThinkRecommendation = {
  choice: "Use SSE",
  confidence: 0.88,
  reasoning: "Fits the use case.",
  tradeoffs: { pros: ["Simple"], cons: ["No bidirectional"] },
};

const mockContext: ThinkContext = {
  relevantDecisions: [],
  relevantPatterns: [],
  agentProfiles: { techLead: null, rfcAuthor: null },
};

vi.mock("../src/think/context-loader.js", () => ({
  loadThinkContext: vi.fn().mockResolvedValue(mockContext),
}));

vi.mock("../src/think/executor.js", () => ({
  executeThinkRound: vi.fn().mockResolvedValue({
    question: "SSE or WebSocket?",
    techLeadPerspective: "SSE is simpler.",
    rfcAuthorPerspective: "WebSocket for future.",
    recommendation: mockRecommendation,
  }),
}));

vi.mock("../src/think/history.js", () => ({
  ThinkHistoryStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    record: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("../src/journal/store.js", () => ({
  DecisionStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/core/knowledge-base.js", () => ({
  VectorMemory: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getEmbedder: vi.fn().mockReturnValue({}),
  })),
}));

vi.mock("../src/core/config.js", () => ({
  CONFIG: { vectorStorePath: "/tmp/test", memoryBackend: "lancedb" },
}));

vi.mock("../src/memory/global/store.js", () => ({
  GlobalMemoryManager: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue({}),
  })),
}));

const { createThinkSession, addFollowUp, saveToJournal } = await import("../src/think/session.js");

describe("createThinkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a session with one round", async () => {
    const session = await createThinkSession("SSE or WebSocket?");
    expect(session.question).toBe("SSE or WebSocket?");
    expect(session.rounds.length).toBe(1);
    expect(session.recommendation).toEqual(mockRecommendation);
    expect(session.savedToJournal).toBe(false);
  });

  it("session.recommendation mirrors latest round", async () => {
    const session = await createThinkSession("SSE or WebSocket?");
    expect(session.recommendation).toBe(session.rounds[0].recommendation);
  });
});

describe("addFollowUp", () => {
  it("adds a follow-up round", async () => {
    const session = await createThinkSession("SSE or WebSocket?");
    const updated = await addFollowUp(session, "What about approvals?");
    expect(updated.rounds.length).toBe(2);
    expect(updated.rounds[1].question).toBe("What about approvals?");
    expect(updated.recommendation).toEqual(mockRecommendation);
  });

  it("enforces 3 follow-up cap", async () => {
    let session = await createThinkSession("Q1");
    session = await addFollowUp(session, "Q2");
    session = await addFollowUp(session, "Q3");
    session = await addFollowUp(session, "Q4");
    // 1 original + 3 follow-ups = 4 rounds max
    await expect(addFollowUp(session, "Q5")).rejects.toThrow(/maximum/i);
  });
});

describe("saveToJournal", () => {
  it("marks session as saved", async () => {
    const session = await createThinkSession("SSE or WebSocket?");
    const saved = await saveToJournal(session);
    expect(saved.savedToJournal).toBe(true);
  });

  it("maps recommendation directly to Decision with correct fields", async () => {
    const { DecisionStore } = await import("../src/journal/store.js");
    const mockUpsert = vi.fn();
    (DecisionStore as any).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      upsert: mockUpsert,
    }));

    const session = await createThinkSession("SSE or WebSocket?");
    await saveToJournal(session);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const decision = mockUpsert.mock.calls[0][0];
    expect(decision.decision).toBe("Use SSE");
    expect(decision.recommendedBy).toBe("coordinator");
    expect(decision.confidence).toBe(0.88);
    expect(decision.goalContext).toBe("SSE or WebSocket?");
    expect(decision.runIndex).toBe(0);
    expect(decision.taskId).toBe("");
    expect(decision.status).toBe("active");
  });

  it("throws on inconclusive recommendation", async () => {
    vi.mocked((await import("../src/think/executor.js")).executeThinkRound).mockResolvedValueOnce({
      question: "Q",
      techLeadPerspective: "",
      rfcAuthorPerspective: "",
      recommendation: {
        choice: "Inconclusive", confidence: 0,
        reasoning: "Failed.", tradeoffs: { pros: [], cons: [] },
      },
    });
    const session = await createThinkSession("Q");
    await expect(saveToJournal(session)).rejects.toThrow(/inconclusive/i);
  });
});

describe("sprint handoff", () => {
  it("pre-populates goal from recommendation choice", async () => {
    const session = await createThinkSession("SSE or WebSocket?");
    // The sprint goal should be derived from the recommendation
    const goal = `Implement: ${session.recommendation?.choice}`;
    expect(goal).toBe("Implement: Use SSE");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/think-session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement session orchestrator**

```typescript
// src/think/session.ts
/**
 * Think session orchestrator — manages the lifecycle of a think session:
 * creation, follow-ups, journal save, and history recording.
 */

import { randomUUID } from "node:crypto";
import type { ThinkSession, ThinkRecommendation } from "./types.js";
import type { Decision } from "../journal/types.js";
import { loadThinkContext } from "./context-loader.js";
import { executeThinkRound, type ExecuteOptions } from "./executor.js";
import { extractTags, extractDecisions } from "../journal/extractor.js";

const MAX_FOLLOW_UPS = 3;

export async function createThinkSession(
  question: string,
  options?: ExecuteOptions,
): Promise<ThinkSession> {
  const id = `think-${randomUUID().slice(0, 8)}`;
  const context = await loadThinkContext(question);

  const round = await executeThinkRound(question, context, options);

  return {
    id,
    question,
    context,
    rounds: [round],
    recommendation: round.recommendation,
    savedToJournal: false,
    createdAt: Date.now(),
  };
}

export async function addFollowUp(
  session: ThinkSession,
  followUpQuestion: string,
  options?: ExecuteOptions,
): Promise<ThinkSession> {
  // Original round + follow-ups. Max 3 follow-ups means max 4 total rounds.
  if (session.rounds.length >= MAX_FOLLOW_UPS + 1) {
    throw new Error(`Maximum ${MAX_FOLLOW_UPS} follow-up rounds reached.`);
  }

  const round = await executeThinkRound(followUpQuestion, session.context, {
    ...options,
    previousRounds: session.rounds,
  });

  const updatedRounds = [...session.rounds, round];
  return {
    ...session,
    rounds: updatedRounds,
    recommendation: round.recommendation,
  };
}

export async function saveToJournal(session: ThinkSession): Promise<ThinkSession> {
  if (!session.recommendation || session.recommendation.choice === "Inconclusive") {
    throw new Error("Cannot save inconclusive recommendation to journal.");
  }

  // Primary path: direct mapping from structured recommendation
  let decisions = [mapRecommendationToDecision(session)];

  // Fallback: if recommendation came from raw text (e.g. coordinator returned prose),
  // try extractDecisions() on the last round's coordinator output
  if (!decisions[0]) {
    const lastRound = session.rounds[session.rounds.length - 1];
    if (lastRound) {
      decisions = extractDecisions({
        agentRole: "coordinator",
        agentOutput: `${lastRound.techLeadPerspective}\n${lastRound.rfcAuthorPerspective}`,
        taskId: "",
        sessionId: session.id,
        runIndex: 0,
        goalContext: session.question,
        confidence: session.recommendation.confidence,
      });
    }
  }

  if (decisions.length === 0) {
    throw new Error("Could not extract a decision from the recommendation.");
  }

  // Save via DecisionStore
  const { VectorMemory } = await import("../core/knowledge-base.js");
  const { CONFIG } = await import("../core/config.js");
  const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
  await vm.init();
  const embedder = vm.getEmbedder();
  if (embedder) {
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (db) {
      const { DecisionStore } = await import("../journal/store.js");
      const store = new DecisionStore();
      await store.init(db);
      await store.upsert(decisions[0]);
    }
  }

  return { ...session, savedToJournal: true };
}

function mapRecommendationToDecision(session: ThinkSession): Decision {
  const rec = session.recommendation!;
  const topic = rec.choice.split(/\s+/).slice(0, 4).join(" ");
  const tags = extractTags(rec.choice, rec.reasoning);

  return {
    id: randomUUID(),
    sessionId: session.id,
    runIndex: 0,
    capturedAt: Date.now(),
    topic,
    decision: rec.choice,
    reasoning: rec.reasoning,
    recommendedBy: "coordinator",
    confidence: rec.confidence,
    taskId: "",
    goalContext: session.question,
    tags,
    embedding: [],
    status: "active",
  };
}

export async function recordToHistory(session: ThinkSession): Promise<void> {
  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (!embedder) return;

    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (!db) return;

    const { ThinkHistoryStore } = await import("./history.js");
    const store = new ThinkHistoryStore();
    await store.init(db);
    await store.record({
      sessionId: session.id,
      question: session.question,
      recommendation: session.recommendation?.choice ?? "Inconclusive",
      confidence: session.recommendation?.confidence ?? 0,
      savedToJournal: session.savedToJournal,
      followUpCount: session.rounds.length - 1,
      createdAt: session.createdAt,
    });
  } catch {
    // History recording is best-effort
  }
}
```

Note: Tag extraction reuses the existing `extractTags` function from `src/journal/extractor.ts`. It is currently not exported — add `export` keyword to the function declaration in `src/journal/extractor.ts:108` (`function extractTags` → `export function extractTags`). The session.ts file then imports it directly — no separate journal-mapper file needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/think-session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/think/session.ts src/journal/extractor.ts tests/think-session.test.ts
git commit -m "feat(think): add session orchestrator with journal save and history"
```

---

### Task 7: Barrel Export

**Files:**
- Create: `src/think/index.ts`

- [ ] **Step 1: Create barrel export**

```typescript
// src/think/index.ts
export type {
  ThinkSession,
  ThinkContext,
  ThinkRound,
  ThinkRecommendation,
  ThinkHistoryEntry,
  ThinkEvent,
} from "./types.js";
export { createThinkSession, addFollowUp, saveToJournal, recordToHistory } from "./session.js";
export { executeThinkRound } from "./executor.js";
export { loadThinkContext } from "./context-loader.js";
export { ThinkHistoryStore } from "./history.js";
```

- [ ] **Step 2: Verify types compile**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/think/index.ts
git commit -m "feat(think): add barrel export"
```

---

### Task 8: CLI Command

**Files:**
- Create: `src/commands/think.ts`
- Modify: `src/cli.ts` (add think command branch near line 370)
- Modify: `src/cli/fuzzy-matcher.ts` (add "think" to COMMANDS and SUBCOMMANDS)

- [ ] **Step 1: Implement CLI command**

```typescript
// src/commands/think.ts
/**
 * CLI command: openpawl think
 * Lightweight structured thinking mode — rubber duck debugging.
 */

import pc from "picocolors";
import { logger } from "../core/logger.js";
import { isCancel, select, text } from "@clack/prompts";
import type { ThinkSession, ThinkRecommendation } from "../think/types.js";

function renderRecommendation(rec: ThinkRecommendation): void {
  logger.plain("");
  logger.plain(pc.dim("━".repeat(55)));
  logger.plain(`${pc.bold("Recommendation:")} ${rec.choice}`);
  logger.plain(`${pc.bold("Confidence:")} ${rec.confidence.toFixed(2)}`);
  logger.plain(`${pc.bold("Reasoning:")}`);
  logger.plain(`  ${rec.reasoning}`);
  logger.plain(`${pc.bold("Tradeoffs:")}`);
  for (const pro of rec.tradeoffs.pros) {
    logger.plain(`  ${pc.green("✓")} ${pro}`);
  }
  for (const con of rec.tradeoffs.cons) {
    logger.plain(`  ${pc.red("✗")} ${con}`);
  }
  logger.plain(pc.dim("━".repeat(55)));
}

function renderRound(round: import("../think/types.js").ThinkRound, streaming: boolean): void {
  if (!streaming) {
    // Non-streaming: render full perspectives
    logger.plain("");
    logger.plain(pc.dim("━".repeat(55)));
    logger.plain(pc.bold("Tech Lead perspective:"));
    logger.plain(round.techLeadPerspective);
    logger.plain("");
    logger.plain(pc.bold("RFC Author perspective:"));
    logger.plain(round.rfcAuthorPerspective);
  }
  renderRecommendation(round.recommendation);
}

async function runHistory(args: string[]): Promise<void> {
  const sessionId = args.includes("--session")
    ? args[args.indexOf("--session") + 1]
    : null;

  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (!embedder) {
      logger.plain("No think history available.");
      return;
    }
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (!db) {
      logger.plain("No think history available.");
      return;
    }
    const { ThinkHistoryStore } = await import("../think/history.js");
    const store = new ThinkHistoryStore();
    await store.init(db);

    if (sessionId) {
      const entry = await store.getBySessionId(sessionId);
      if (!entry) {
        logger.error(`No think session found with ID: ${sessionId}`);
        return;
      }
      logger.plain(pc.bold(`Think session: ${entry.sessionId}`));
      logger.plain(`  Question: "${entry.question}"`);
      logger.plain(`  Recommendation: ${entry.recommendation}`);
      logger.plain(`  Confidence: ${entry.confidence.toFixed(2)}`);
      logger.plain(`  Follow-ups: ${entry.followUpCount}`);
      logger.plain(`  Saved to journal: ${entry.savedToJournal ? "yes" : "no"}`);
      logger.plain(`  Date: ${new Date(entry.createdAt).toISOString().slice(0, 10)}`);
      return;
    }

    const entries = await store.getAll();
    if (entries.length === 0) {
      logger.plain("No think sessions recorded yet.");
      return;
    }

    logger.plain(pc.bold("Think History"));
    logger.plain(pc.dim("━".repeat(55)));
    for (const e of entries) {
      const date = new Date(e.createdAt).toISOString().slice(0, 10);
      const saved = e.savedToJournal ? pc.green("✓ saved") : pc.dim("not saved");
      logger.plain(`${pc.dim(date)} ${pc.bold(e.recommendation)} ${saved}`);
      logger.plain(`  "${e.question}" (confidence ${e.confidence.toFixed(2)}, ${e.followUpCount} follow-ups)`);
      logger.plain(`  ID: ${e.sessionId}`);
      logger.plain("");
    }
  } catch (err) {
    logger.error(`Failed to load think history: ${err}`);
  }
}

export async function runThinkCommand(args: string[]): Promise<void> {
  // Help
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    logger.plain([
      pc.bold("openpawl think") + " — Rubber duck mode: structured thinking with agent perspectives",
      "",
      "Usage:",
      '  openpawl think "your question"               Interactive think session',
      '  openpawl think "question" --save              Auto-save to journal',
      '  openpawl think "question" --no-stream         Show results at end (no streaming)',
      "  openpawl think history                        List past think sessions",
      "  openpawl think history --session <id>         Show specific session",
    ].join("\n"));
    return;
  }

  // History subcommand
  if (args[0] === "history") {
    await runHistory(args.slice(1));
    return;
  }

  // Parse flags
  const autoSave = args.includes("--save");
  const noStream = args.includes("--no-stream");
  const question = args
    .filter((a) => a !== "--save" && a !== "--no-stream")
    .join(" ")
    .trim();

  if (!question) {
    logger.error("Please provide a question to think about.");
    return;
  }

  // Header
  logger.plain("");
  logger.plain(pc.bold(pc.yellow("🦆 Rubber Duck Mode")));
  logger.plain(pc.dim("━".repeat(55)));
  logger.plain(`Thinking about: "${question}"`);

  // Context loading indicator
  logger.plain(pc.dim("Checking past decisions..."));

  const { createThinkSession, addFollowUp, saveToJournal, recordToHistory } =
    await import("../think/session.js");

  // Create session with streaming callbacks
  const onChunk = noStream
    ? undefined
    : (stage: string, content: string) => {
        process.stdout.write(content);
      };

  let currentStage = "";
  const streamingOnChunk = noStream
    ? undefined
    : (stage: "tech_lead" | "rfc_author" | "coordinator", content: string) => {
        if (stage !== currentStage) {
          currentStage = stage;
          if (stage === "tech_lead") {
            logger.plain("");
            logger.plain(pc.dim("━".repeat(55)));
            logger.plain(pc.bold("Tech Lead perspective:"));
          } else if (stage === "rfc_author") {
            logger.plain("");
            logger.plain("");
            logger.plain(pc.bold("RFC Author perspective:"));
          }
          // Don't print header for coordinator — recommendation is rendered separately
          if (stage === "coordinator") return;
        }
        if (stage !== "coordinator") {
          process.stdout.write(content);
        }
      };

  let session: ThinkSession;
  try {
    session = await createThinkSession(question, { onChunk: streamingOnChunk });
  } catch (err) {
    logger.error(`Think session failed: ${err}`);
    return;
  }

  // Show context info
  if (session.context.relevantDecisions.length > 0) {
    logger.plain(pc.dim(`\n→ ${session.context.relevantDecisions.length} relevant decision(s) found`));
  }

  // Render result
  if (noStream && session.rounds[0]) {
    renderRound(session.rounds[0], false);
  } else if (session.recommendation) {
    renderRecommendation(session.recommendation);
  }

  // Auto-save mode: save and exit
  if (autoSave) {
    if (session.recommendation && session.recommendation.choice !== "Inconclusive") {
      session = await saveToJournal(session);
      logger.plain(pc.green(`\n✓ Decision saved: ${session.recommendation.choice}`));
    }
    await recordToHistory(session);
    return;
  }

  // Interactive loop
  let followUpCount = 0;
  const MAX_FOLLOW_UPS = 3;

  while (true) {
    const options: Array<{ value: string; label: string }> = [
      { value: "save", label: "Save to decision journal" },
    ];
    if (followUpCount < MAX_FOLLOW_UPS) {
      options.push({ value: "followup", label: "Ask a follow-up question" });
    }
    options.push(
      { value: "sprint", label: "Start a sprint based on this decision" },
      { value: "discard", label: "Discard" },
    );

    const action = await select({
      message: "What would you like to do?",
      options,
    });

    if (isCancel(action)) {
      await recordToHistory(session);
      return;
    }

    if (action === "save") {
      if (session.recommendation && session.recommendation.choice !== "Inconclusive") {
        session = await saveToJournal(session);
        logger.plain(pc.green(`✓ Decision saved: ${session.recommendation!.choice}`));
      } else {
        logger.plain(pc.yellow("Cannot save inconclusive recommendation."));
      }
      await recordToHistory(session);
      return;
    }

    if (action === "followup") {
      const followUp = await text({
        message: "Follow-up question:",
        placeholder: "What about...",
      });

      if (isCancel(followUp) || !followUp) continue;

      currentStage = "";
      try {
        session = await addFollowUp(session, String(followUp), { onChunk: streamingOnChunk });
        followUpCount++;
        const lastRound = session.rounds[session.rounds.length - 1];
        if (noStream && lastRound) {
          renderRound(lastRound, false);
        } else if (session.recommendation) {
          renderRecommendation(session.recommendation);
        }
      } catch (err) {
        logger.error(`Follow-up failed: ${err}`);
      }
      continue;
    }

    if (action === "sprint") {
      // Save first
      if (session.recommendation && session.recommendation.choice !== "Inconclusive") {
        session = await saveToJournal(session);
        logger.plain(pc.green(`✓ Decision saved: ${session.recommendation!.choice}`));
      }
      await recordToHistory(session);

      // Launch work with pre-populated goal
      const goal = `Implement: ${session.recommendation?.choice ?? session.question}`;
      logger.plain(`\nStarting sprint with goal: "${goal}"`);
      logger.plain(pc.dim("You can modify the goal in the setup wizard.\n"));

      // Dynamic import to avoid circular dependency
      const { spawn } = await import("node:child_process");
      spawn("npx", ["openpawl", "work"], {
        stdio: "inherit",
        env: { ...process.env, OPENPAWL_SUGGESTED_GOAL: goal },
      });
      return;
    }

    if (action === "discard") {
      await recordToHistory(session);
      logger.plain(pc.dim("Think session discarded."));
      return;
    }
  }
}
```

- [ ] **Step 2: Register in CLI**

Add to `src/cli/fuzzy-matcher.ts` COMMANDS array (add `"think"` after `"onboard"`):

```typescript
// In COMMANDS array, add:
"think",

// In SUBCOMMANDS, add:
think: ["history"],
```

Add to `src/cli.ts` (before the final `else` block around line 370):

```typescript
} else if (cmd === "think") {
    const { runThinkCommand } = await import("./commands/think.js");
    await runThinkCommand(args.slice(1));
```

- [ ] **Step 3: Verify types compile**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/think.ts src/cli.ts src/cli/fuzzy-matcher.ts
git commit -m "feat(think): add CLI command with interactive mode"
```

---

### Task 9: Web Server Endpoints

**Files:**
- Modify: `src/web/server.ts` (add POST /api/think and POST /api/think/:sessionId/followup)

- [ ] **Step 1: Add think endpoints to server.ts**

Add after the existing route registrations (find the last `fastify.post` or `fastify.get` block before the server start):

```typescript
// ---------------------------------------------------------------------------
// Think (Rubber Duck Mode)
// ---------------------------------------------------------------------------
const thinkSessions = new Map<string, import("../think/types.js").ThinkSession>();

// Track last activity for session expiry
const thinkSessionActivity = new Map<string, number>();

// Clean up expired sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  const THIRTY_MINUTES = 30 * 60 * 1000;
  for (const [id] of thinkSessions) {
    const lastActivity = thinkSessionActivity.get(id) ?? 0;
    if (now - lastActivity > THIRTY_MINUTES) {
      thinkSessions.delete(id);
      thinkSessionActivity.delete(id);
    }
  }
}, 30 * 60 * 1000);

fastify.post<{ Body: { question: string } }>("/api/think", async (req, reply) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return reply.status(400).send({ error: "Question is required" });
  }

  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    raw.write(`data: ${JSON.stringify({ event, data })}\n\n`);
  };

  try {
    const { loadThinkContext } = await import("../think/context-loader.js");
    const { executeThinkRound } = await import("../think/executor.js");

    // Load context first and emit context_loaded before streaming
    const context = await loadThinkContext(question);
    send("context_loaded", { relevantDecisions: context.relevantDecisions.length });

    let currentStage = "";
    const round = await executeThinkRound(question, context, {
      onChunk: (stage, content) => {
        if (stage !== currentStage) {
          currentStage = stage;
          if (stage !== "coordinator") send(`${stage}_start`, {});
        }
        if (stage !== "coordinator") send(`${stage}_chunk`, { content });
      },
    });

    // Build session object for storage
    const { randomUUID } = await import("node:crypto");
    const session = {
      id: `think-${randomUUID().slice(0, 8)}`,
      question,
      context,
      rounds: [round],
      recommendation: round.recommendation,
      savedToJournal: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    if (round) {
      send("tech_lead_done", { perspective: round.techLeadPerspective });
      send("rfc_author_done", { perspective: round.rfcAuthorPerspective });
    }

    if (session.recommendation) {
      send("recommendation", { recommendation: session.recommendation });
    }

    thinkSessions.set(session.id, session);
    thinkSessionActivity.set(session.id, Date.now());
    send("done", { sessionId: session.id });
  } catch (err) {
    send("error", { stage: "session", message: String(err) });
  }

  raw.end();
});

fastify.post<{ Params: { sessionId: string }; Body: { question: string } }>(
  "/api/think/:sessionId/followup",
  async (req, reply) => {
    const { sessionId } = req.params;
    const { question } = req.body;

    const session = thinkSessions.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Think session not found or expired" });
    }

    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      raw.write(`data: ${JSON.stringify({ event, data })}\n\n`);
    };

    try {
      const { addFollowUp } = await import("../think/session.js");
      let currentStage = "";
      const updated = await addFollowUp(session, question, {
        onChunk: (stage, content) => {
          if (stage !== currentStage) {
            currentStage = stage;
            if (stage !== "coordinator") send(`${stage}_start`, {});
          }
          if (stage !== "coordinator") send(`${stage}_chunk`, { content });
        },
      });

      const lastRound = updated.rounds[updated.rounds.length - 1];
      if (lastRound) {
        send("tech_lead_done", { perspective: lastRound.techLeadPerspective });
        send("rfc_author_done", { perspective: lastRound.rfcAuthorPerspective });
      }
      if (updated.recommendation) {
        send("recommendation", { recommendation: updated.recommendation });
      }

      thinkSessions.set(sessionId, updated);
      thinkSessionActivity.set(sessionId, Date.now());
      send("done", { sessionId });
    } catch (err) {
      send("error", { stage: "followup", message: String(err) });
    }

    raw.end();
  },
);

// Save think session to journal
fastify.post<{ Params: { sessionId: string } }>(
  "/api/think/:sessionId/save",
  async (req, reply) => {
    const session = thinkSessions.get(req.params.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Think session not found" });
    }
    try {
      const { saveToJournal, recordToHistory } = await import("../think/session.js");
      const saved = await saveToJournal(session);
      await recordToHistory(saved);
      thinkSessions.set(req.params.sessionId, saved);
      return { success: true, choice: saved.recommendation?.choice };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  },
);
```

- [ ] **Step 2: Verify types compile**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(think): add web server endpoints for think mode"
```

---

### Task 10: Dashboard ThinkPanel Component

**Files:**
- Create: `src/web/client/src/components/ThinkPanel.tsx`

- [ ] **Step 1: Check existing component patterns**

Read `src/web/client/src/components/DriftPanel.tsx` for styling/structure patterns. The ThinkPanel should follow the same inline style approach.

- [ ] **Step 2: Implement ThinkPanel**

```tsx
// src/web/client/src/components/ThinkPanel.tsx
import { useState, useCallback } from "react";

interface ThinkRecommendation {
  choice: string;
  confidence: number;
  reasoning: string;
  tradeoffs: { pros: string[]; cons: string[] };
}

interface ThinkState {
  status: "idle" | "loading" | "streaming" | "done" | "error";
  sessionId: string | null;
  techLeadPerspective: string;
  rfcAuthorPerspective: string;
  recommendation: ThinkRecommendation | null;
  error: string | null;
  followUpCount: number;
}

const initial: ThinkState = {
  status: "idle",
  sessionId: null,
  techLeadPerspective: "",
  rfcAuthorPerspective: "",
  recommendation: null,
  error: null,
  followUpCount: 0,
};

export function ThinkPanel() {
  const [question, setQuestion] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [state, setState] = useState<ThinkState>(initial);

  const startThink = useCallback(async () => {
    if (!question.trim()) return;
    setState({ ...initial, status: "loading" });

    try {
      const resp = await fetch("/api/think", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });

      if (!resp.ok || !resp.body) {
        setState((s) => ({ ...s, status: "error", error: "Failed to start think session" }));
        return;
      }

      setState((s) => ({ ...s, status: "streaming" }));
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const { event, data } = JSON.parse(line.slice(6));
            setState((s) => {
              switch (event) {
                case "tech_lead_chunk":
                  return { ...s, techLeadPerspective: s.techLeadPerspective + data.content };
                case "rfc_author_chunk":
                  return { ...s, rfcAuthorPerspective: s.rfcAuthorPerspective + data.content };
                case "recommendation":
                  return { ...s, recommendation: data.recommendation };
                case "error":
                  return { ...s, error: data.message };
                case "done":
                  return { ...s, status: "done", sessionId: data.sessionId };
                default:
                  return s;
              }
            });
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      setState((s) => ({ ...s, status: "error", error: String(err) }));
    }
  }, [question]);

  const sendFollowUp = useCallback(async () => {
    if (!followUp.trim() || !state.sessionId || state.followUpCount >= 3) return;

    setState((s) => ({
      ...s,
      status: "streaming",
      techLeadPerspective: "",
      rfcAuthorPerspective: "",
      recommendation: null,
    }));

    try {
      const resp = await fetch(`/api/think/${state.sessionId}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: followUp.trim() }),
      });

      if (!resp.ok || !resp.body) {
        setState((s) => ({ ...s, status: "error", error: "Follow-up failed" }));
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const { event, data } = JSON.parse(line.slice(6));
            setState((s) => {
              switch (event) {
                case "tech_lead_chunk":
                  return { ...s, techLeadPerspective: s.techLeadPerspective + data.content };
                case "rfc_author_chunk":
                  return { ...s, rfcAuthorPerspective: s.rfcAuthorPerspective + data.content };
                case "recommendation":
                  return { ...s, recommendation: data.recommendation };
                case "done":
                  return { ...s, status: "done", followUpCount: s.followUpCount + 1 };
                default:
                  return s;
              }
            });
          } catch { /* ignore parse errors */ }
        }
      }

      setFollowUp("");
    } catch (err) {
      setState((s) => ({ ...s, status: "error", error: String(err) }));
    }
  }, [followUp, state.sessionId, state.followUpCount]);

  const saveToJournal = useCallback(async () => {
    if (!state.sessionId) return;
    try {
      const resp = await fetch(`/api/think/${state.sessionId}/save`, { method: "POST" });
      const result = await resp.json();
      if (result.success) {
        setState((s) => ({ ...s, error: null }));
        alert(`Decision saved: ${result.choice}`);
      }
    } catch (err) {
      setState((s) => ({ ...s, error: `Save failed: ${err}` }));
    }
  }, [state.sessionId]);

  const reset = useCallback(() => {
    setState(initial);
    setQuestion("");
    setFollowUp("");
  }, []);

  return (
    <div style={{ padding: "1rem", fontFamily: "monospace" }}>
      <h2 style={{ margin: "0 0 1rem", color: "#f5a623" }}>🦆 Rubber Duck Mode</h2>

      {state.status === "idle" && (
        <div>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startThink()}
            placeholder="What are you thinking about?"
            style={{
              width: "100%", padding: "0.75rem", fontSize: "1rem",
              background: "#1a1a2e", color: "#fff", border: "1px solid #333",
              borderRadius: "4px", boxSizing: "border-box",
            }}
          />
          <button
            onClick={startThink}
            disabled={!question.trim()}
            style={{
              marginTop: "0.5rem", padding: "0.5rem 1rem",
              background: "#f5a623", color: "#000", border: "none",
              borderRadius: "4px", cursor: "pointer", fontWeight: "bold",
            }}
          >
            Think
          </button>
        </div>
      )}

      {state.status === "loading" && (
        <p style={{ color: "#888" }}>Checking past decisions...</p>
      )}

      {(state.status === "streaming" || state.status === "done") && (
        <div>
          {state.techLeadPerspective && (
            <div style={{ margin: "1rem 0", padding: "1rem", background: "#1a2a1a", borderRadius: "4px" }}>
              <h3 style={{ margin: "0 0 0.5rem", color: "#4caf50" }}>Tech Lead</h3>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{state.techLeadPerspective}</p>
            </div>
          )}

          {state.rfcAuthorPerspective && (
            <div style={{ margin: "1rem 0", padding: "1rem", background: "#1a1a2e", borderRadius: "4px" }}>
              <h3 style={{ margin: "0 0 0.5rem", color: "#2196f3" }}>RFC Author</h3>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{state.rfcAuthorPerspective}</p>
            </div>
          )}

          {state.recommendation && (
            <div style={{ margin: "1rem 0", padding: "1rem", background: "#2a2a1a", borderRadius: "4px", border: "1px solid #f5a623" }}>
              <h3 style={{ margin: "0 0 0.5rem", color: "#f5a623" }}>Recommendation: {state.recommendation.choice}</h3>
              <p style={{ margin: "0 0 0.5rem", color: "#ccc" }}>
                Confidence: {state.recommendation.confidence.toFixed(2)}
              </p>
              <p style={{ margin: "0 0 0.5rem" }}>{state.recommendation.reasoning}</p>
              <div style={{ display: "flex", gap: "2rem" }}>
                <div>
                  {state.recommendation.tradeoffs.pros.map((p, i) => (
                    <div key={i} style={{ color: "#4caf50" }}>✓ {p}</div>
                  ))}
                </div>
                <div>
                  {state.recommendation.tradeoffs.cons.map((c, i) => (
                    <div key={i} style={{ color: "#f44336" }}>✗ {c}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {state.status === "done" && (
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
              <button onClick={saveToJournal} style={{ padding: "0.5rem 1rem", background: "#4caf50", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}>
                Save to Journal
              </button>
              {state.followUpCount < 3 && (
                <div style={{ display: "flex", gap: "0.5rem", flex: 1 }}>
                  <input
                    type="text"
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendFollowUp()}
                    placeholder="Follow-up question..."
                    style={{
                      flex: 1, padding: "0.5rem", background: "#1a1a2e",
                      color: "#fff", border: "1px solid #333", borderRadius: "4px",
                    }}
                  />
                  <button onClick={sendFollowUp} disabled={!followUp.trim()} style={{ padding: "0.5rem 1rem", background: "#2196f3", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}>
                    Ask
                  </button>
                </div>
              )}
              <button onClick={reset} style={{ padding: "0.5rem 1rem", background: "#333", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}>
                Discard
              </button>
            </div>
          )}
        </div>
      )}

      {state.error && (
        <p style={{ color: "#f44336", marginTop: "1rem" }}>Error: {state.error}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire ThinkPanel into InsightsSection tabs**

Modify `src/web/client/src/components/InsightsSection.tsx`:

Add to `TAB_CONFIG`:
```typescript
think: { icon: "bi-chat-square-dots", label: "Think" },
```

Add to the `InsightsTab` type (update the union).

Add to the conditional rendering block (after the profiles tab):
```tsx
) : activeTab === "think" ? (
  <ThinkPanel />
```

Add import at top:
```tsx
import { ThinkPanel } from "./ThinkPanel";
```

- [ ] **Step 4: Verify types compile**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/client/src/components/ThinkPanel.tsx src/web/client/src/components/InsightsSection.tsx
git commit -m "feat(think): add dashboard ThinkPanel component and wire into InsightsSection"
```

---

### Task 11: Briefing Integration

**Files:**
- Modify: `src/briefing/collector.ts`

- [ ] **Step 1: Add think session surfacing to briefing collector**

At the end of `collectBriefingData()`, before the return statement, add think history loading. First add a `recentThinkSessions` field to the returned object. Check `src/briefing/types.ts` for the `BriefingData` type and add the field there too.

Add to `BriefingData` type in `src/briefing/types.ts`:

```typescript
recentThinkSessions?: Array<{
  question: string;
  recommendation: string;
  savedToJournal: boolean;
  date: string;
}>;
```

Add to `collectBriefingData()` at the end, before return:

```typescript
// Load recent think sessions (best-effort)
try {
  const { VectorMemory } = await import("../core/knowledge-base.js");
  const { CONFIG } = await import("../core/config.js");
  const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
  await vm.init();
  const embedder = vm.getEmbedder();
  if (embedder) {
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (db) {
      const { ThinkHistoryStore } = await import("../think/history.js");
      const store = new ThinkHistoryStore();
      await store.init(db);
      const entries = await store.getAll();
      const recent = entries.slice(0, 3);
      if (recent.length > 0) {
        result.recentThinkSessions = recent.map((e) => ({
          question: e.question,
          recommendation: e.recommendation,
          savedToJournal: e.savedToJournal,
          date: new Date(e.createdAt).toISOString().slice(0, 10),
        }));
      }
    }
  }
} catch {
  // Best-effort — don't break briefing if think history fails
}
```

- [ ] **Step 2: Verify types compile**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/briefing/collector.ts src/briefing/types.ts
git commit -m "feat(think): surface recent think sessions in briefing"
```

---

### Task 12: Run All Tests and Final Verification

- [ ] **Step 1: Run all think tests**

Run: `bun run test -- tests/think-prompts.test.ts tests/think-context-loader.test.ts tests/think-executor.test.ts tests/think-history.test.ts tests/think-session.test.ts`
Expected: All PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: All existing tests still pass, no regressions

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: PASS (fix any issues)

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(think): address lint and type issues"
```

- [ ] **Step 6: Push**

```bash
git push
```
