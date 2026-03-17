import { describe, it, expect } from "vitest";
import { formatSlackThinkResult, buildThinkWebhookPayload } from "../src/think/notifier.js";
import type { AsyncThinkJob } from "../src/think/async-types.js";
import type { ThinkSession } from "../src/think/types.js";

function makeSession(): ThinkSession {
  return {
    id: "think-abc123",
    question: "Should we use Redis or Postgres for caching?",
    context: {
      relevantDecisions: [],
      relevantPatterns: [],
      agentProfiles: { techLead: null, rfcAuthor: null },
    },
    rounds: [
      {
        question: "Should we use Redis or Postgres for caching?",
        techLeadPerspective: "Redis is better for caching.",
        rfcAuthorPerspective: "Postgres can work too.",
        recommendation: {
          choice: "Use Redis for caching",
          confidence: 0.85,
          reasoning: "Redis provides better cache semantics.",
          tradeoffs: {
            pros: ["Lower latency", "Built-in TTL"],
            cons: ["Extra infrastructure", "Memory cost"],
          },
        },
      },
    ],
    recommendation: {
      choice: "Use Redis for caching",
      confidence: 0.85,
      reasoning: "Redis provides better cache semantics.",
      tradeoffs: {
        pros: ["Lower latency", "Built-in TTL"],
        cons: ["Extra infrastructure", "Memory cost"],
      },
    },
    savedToJournal: true,
    createdAt: 1700000000000,
  };
}

function makeJob(overrides: Partial<AsyncThinkJob> = {}): AsyncThinkJob {
  return {
    id: "athink_test123",
    question: "Should we use Redis or Postgres for caching?",
    status: "completed",
    pid: 12345,
    createdAt: 1700000000000,
    startedAt: 1700000001000,
    completedAt: 1700000060000,
    error: null,
    result: makeSession(),
    notificationSent: false,
    briefedAt: null,
    autoSave: true,
    ...overrides,
  };
}

describe("async think notifier", () => {
  describe("formatSlackThinkResult", () => {
    it("produces valid Block Kit structure", () => {
      const job = makeJob();
      const payload = formatSlackThinkResult(job);
      const blocks = payload.blocks as Array<{ type: string; text?: { type: string; text: string } }>;

      expect(blocks).toBeDefined();
      expect(blocks.length).toBeGreaterThanOrEqual(3);

      // Header
      expect(blocks[0].type).toBe("header");
      expect(blocks[0].text?.text).toContain("TeamClaw finished thinking");

      // Context with job ID
      expect(blocks[1].type).toBe("context");

      // Question section
      expect(blocks[2].type).toBe("section");
      expect(blocks[2].text?.text).toContain("Redis");
    });

    it("includes recommendation details", () => {
      const job = makeJob();
      const payload = formatSlackThinkResult(job);
      const blocks = payload.blocks as Array<{ type: string; text?: { type: string; text: string } }>;

      const recBlock = blocks.find((b) => b.text?.text?.includes("Recommendation:"));
      expect(recBlock).toBeDefined();
      expect(recBlock!.text!.text).toContain("Use Redis");
      expect(recBlock!.text!.text).toContain("85%");
    });

    it("includes tradeoffs", () => {
      const job = makeJob();
      const payload = formatSlackThinkResult(job);
      const blocks = payload.blocks as Array<{ type: string; text?: { type: string; text: string } }>;

      const tradeoffBlock = blocks.find(
        (b) => b.text?.text?.includes("\u2713") || b.text?.text?.includes("\u2717"),
      );
      expect(tradeoffBlock).toBeDefined();
    });
  });

  describe("buildThinkWebhookPayload", () => {
    it("includes all required fields", () => {
      const job = makeJob();
      const payload = buildThinkWebhookPayload(job);

      expect(payload.event).toBe("think_complete");
      expect(payload.jobId).toBe("athink_test123");
      expect(payload.question).toBe("Should we use Redis or Postgres for caching?");
      expect(payload.recommendation).toBe("Use Redis for caching");
      expect(payload.confidence).toBe(0.85);
      expect(payload.completedAt).toBe(1700000060000);
      expect(payload.durationMs).toBe(59000);
    });

    it("handles job without recommendation", () => {
      const job = makeJob({ result: null });
      const payload = buildThinkWebhookPayload(job);

      expect(payload.recommendation).toBeNull();
      expect(payload.confidence).toBeNull();
    });
  });
});
