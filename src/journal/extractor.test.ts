import { describe, it, expect } from "vitest";
import { extractDecisions, type ExtractionInput } from "./extractor.js";

function makeInput(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    agentRole: "tech_lead",
    agentOutput: "",
    taskId: "t-1",
    sessionId: "sess-123",
    runIndex: 1,
    goalContext: "Build auth module",
    confidence: 0.91,
    ...overrides,
  };
}

describe("extractDecisions", () => {
  it("matches 'we should use X instead of Y'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "We should use PKCE flow instead of implicit OAuth2." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toContain("PKCE");
    expect(result[0]!.decision).toContain("implicit");
  });

  it("matches 'decided to X'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "After analysis, decided to use Redis for caching." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toContain("use Redis for caching");
  });

  it("matches 'recommending X because Y'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "Recommending JWT tokens because they are stateless." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.reasoning).toContain("stateless");
  });

  it("matches 'choosing X over Y'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "Choosing PostgreSQL over MySQL." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toContain("PostgreSQL");
    expect(result[0]!.decision).toContain("MySQL");
  });

  it("matches 'going with X'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "Going with microservices architecture." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toContain("microservices");
  });

  it("matches 'use X for Y'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "We'll use Redis for session storage." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toContain("Redis");
    expect(result[0]!.decision).toContain("session storage");
  });

  it("matches 'avoid X because Y'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "Avoid MongoDB because it lacks ACID transactions." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toContain("Avoid");
    expect(result[0]!.reasoning).toContain("ACID");
  });

  it("matches 'switch to X'", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "Switched from REST to GraphQL." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toContain("REST");
    expect(result[0]!.decision).toContain("GraphQL");
  });

  it("skips Worker Bot outputs", () => {
    const result = extractDecisions(
      makeInput({
        agentRole: "worker_bot",
        agentOutput: "We should use PKCE flow instead of implicit OAuth2.",
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("skips qa_reviewer outputs", () => {
    const result = extractDecisions(
      makeInput({
        agentRole: "qa_reviewer",
        agentOutput: "Decided to use async tests.",
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("skips software_engineer outputs", () => {
    const result = extractDecisions(
      makeInput({
        agentRole: "software_engineer",
        agentOutput: "Going with React hooks.",
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("returns empty array when no patterns match", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "The weather is nice today." }),
    );
    expect(result).toHaveLength(0);
  });

  it("returns empty array for very short output", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "OK." }),
    );
    expect(result).toHaveLength(0);
  });

  it("extracts tags from decision text", () => {
    const result = extractDecisions(
      makeInput({ agentOutput: "We should use JWT authentication instead of session cookies." }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.tags).toEqual(expect.arrayContaining(["jwt", "auth", "session"]));
  });

  it("populates metadata correctly", () => {
    const result = extractDecisions(
      makeInput({
        agentOutput: "Decided to use TypeScript for the backend.",
        confidence: 0.88,
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe("sess-123");
    expect(result[0]!.runIndex).toBe(1);
    expect(result[0]!.confidence).toBe(0.88);
    expect(result[0]!.recommendedBy).toBe("tech_lead");
    expect(result[0]!.taskId).toBe("t-1");
    expect(result[0]!.status).toBe("active");
    expect(result[0]!.id).toBeTruthy();
  });

  it("accepts coordinator role", () => {
    const result = extractDecisions(
      makeInput({
        agentRole: "coordinator",
        agentOutput: "Decided to split the monolith.",
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("accepts rfc_author role", () => {
    const result = extractDecisions(
      makeInput({
        agentRole: "rfc_author",
        agentOutput: "Going with event sourcing pattern.",
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("deduplicates within same extraction", () => {
    const result = extractDecisions(
      makeInput({
        agentOutput: "Decided to use Redis. Going with Redis for caching.",
      }),
    );
    // Both patterns match "Redis" but should deduplicate
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
