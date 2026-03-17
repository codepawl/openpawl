/**
 * Mock LLM mode — intercepts all LLM calls and returns realistic fake responses.
 * Activated by TEAMCLAW_MOCK_LLM=true env var.
 */

/**
 * Check if mock LLM mode is active.
 */
export function isMockLlmEnabled(): boolean {
  return process.env.TEAMCLAW_MOCK_LLM === "true" || process.env.TEAMCLAW_MOCK_LLM === "1";
}

/**
 * Generate a mock LLM response based on the prompt content.
 * Returns realistic output that downstream parsers (confidence, journal, file-blocks) can consume.
 */
export function generateMockResponse(prompt: string, botId: string): string {
  // Detect what kind of response is needed from prompt context
  const lower = prompt.toLowerCase();

  // Coordinator / task decomposition
  if (lower.includes("decompose") || lower.includes("break down") || lower.includes("task decomposition") || botId === "coordinator") {
    return mockCoordinatorResponse();
  }

  // Sprint planning
  if (lower.includes("sprint planning") || lower.includes("sprint plan") || botId.includes("planning")) {
    return mockSprintPlanningResponse();
  }

  // System design
  if (lower.includes("system design") || lower.includes("architecture") || botId.includes("design")) {
    return mockSystemDesignResponse();
  }

  // RFC
  if (lower.includes("rfc") || lower.includes("request for comments") || botId.includes("rfc")) {
    return mockRfcResponse();
  }

  // Think / rubber duck perspectives
  if (lower.includes("tech lead perspective") || lower.includes("as a tech lead")) {
    return mockTechLeadPerspective(prompt);
  }
  if (lower.includes("rfc author") || lower.includes("as an rfc author")) {
    return mockRfcAuthorPerspective(prompt);
  }
  if (lower.includes("synthesize") || lower.includes("recommendation")) {
    return mockCoordinatorSynthesis(prompt);
  }

  // Worker task execution
  if (lower.includes("execute") || lower.includes("implement") || lower.includes("workspace path")) {
    return mockWorkerTaskResponse(prompt);
  }

  // Ping / health
  if (lower.includes("ping") || lower.includes("status")) {
    return "pong — mock LLM active";
  }

  // Default generic response
  return mockGenericResponse(prompt);
}

/**
 * Generate mock CLI JSON output (what `openclaw agent --json` returns).
 */
export function generateMockCliJson(prompt: string, botId: string): string {
  const text = generateMockResponse(prompt, botId);
  return JSON.stringify({
    status: "ok",
    result: {
      payloads: [{ text }],
      meta: {
        agentMeta: {
          model: "mock-model",
          usage: { input: 500, output: 200, cacheRead: 0 },
        },
      },
    },
  });
}

function mockCoordinatorResponse(): string {
  return `Based on the goal, I'll decompose this into the following tasks:

1. **task-mock-1**: Set up project structure and configuration files
   - Priority: high
   - Assigned to: worker-1
   - Timebox: 15 minutes

2. **task-mock-2**: Implement core business logic
   - Priority: high
   - Assigned to: worker-2
   - Timebox: 20 minutes

3. **task-mock-3**: Add API endpoints and routing
   - Priority: medium
   - Assigned to: worker-1
   - Timebox: 15 minutes

4. **task-mock-4**: Write integration tests
   - Priority: medium
   - Assigned to: worker-2
   - Timebox: 15 minutes

<confidence>
score: 0.85
reasoning: Task decomposition follows standard patterns. Clear separation of concerns.
flags: none
</confidence>

<decision>
decision: Use modular architecture with clear separation between API, business logic, and data layers
reasoning: This approach allows independent testing and easier maintenance
recommended_by: coordinator
confidence: 0.85
</decision>`;
}

function mockSprintPlanningResponse(): string {
  return `# Sprint Plan

## Objective
Deliver the requested feature with high quality and comprehensive testing.

## Tasks
1. Core implementation (high priority)
2. API integration (high priority)
3. Testing and validation (medium priority)

## Risk Assessment
- Low risk: Well-defined requirements
- Mitigation: Incremental delivery with review gates

<confidence>
score: 0.88
reasoning: Clear requirements enable confident planning
flags: none
</confidence>`;
}

function mockSystemDesignResponse(): string {
  return `# System Design

## Architecture Overview
Modular architecture with clear boundaries between components.

## Components
1. **API Layer** — Fastify endpoints with validation
2. **Service Layer** — Business logic encapsulation
3. **Data Layer** — LanceDB for persistence

## Data Flow
Client → API → Service → Data → Response

<confidence>
score: 0.90
reasoning: Standard architectural patterns applied
flags: none
</confidence>`;
}

function mockRfcResponse(): string {
  return `# RFC: Implementation Approach

## Summary
Proposing a phased implementation with review gates at each stage.

## Motivation
Ensures quality and allows early feedback.

## Detailed Design
Phase 1: Core scaffolding
Phase 2: Feature implementation
Phase 3: Testing and polish

## Alternatives Considered
- Big-bang approach (rejected: higher risk)
- External service (rejected: adds dependency)

<confidence>
score: 0.82
reasoning: RFC follows established patterns
flags: none
</confidence>`;
}

function mockWorkerTaskResponse(prompt: string): string {
  const taskMatch = prompt.match(/task[_-]id[:\s]*["']?([^"'\s,]+)/i);
  const taskId = taskMatch?.[1] ?? "mock-task";

  return `Task ${taskId} completed successfully.

Implementation details:
- Created the required module with proper exports
- Added error handling for edge cases
- Follows existing code patterns in the codebase

\`\`\`typescript index.ts
export function mockFeature(): string {
  return "Mock implementation";
}
\`\`\`

<confidence>
score: 0.85
reasoning: Implementation follows established patterns. All edge cases handled.
flags: none
</confidence>`;
}

function mockTechLeadPerspective(_prompt: string): string {
  return `## Tech Lead Perspective

From an engineering standpoint, I'd recommend the following approach:

**Architecture**: Use a modular design with clear interfaces between components. This allows independent testing and future extensibility.

**Trade-offs**:
- Pros: Clean separation, testable, maintainable
- Cons: Slightly more initial setup time

**Risk Assessment**: Low risk — this follows patterns we've successfully used before.

**Recommendation**: Proceed with the modular approach. The upfront cost is minimal and the maintainability benefits are significant.`;
}

function mockRfcAuthorPerspective(_prompt: string): string {
  return `## RFC Author Perspective

Looking at this from a specification standpoint:

**Requirements Analysis**: The requirements are clear and well-defined. No ambiguity detected.

**Specification Gaps**: None identified — the scope is well-bounded.

**Standards Compliance**: The proposed approach aligns with industry best practices.

**Documentation Impact**: Minimal — existing docs cover the patterns being used.

**Recommendation**: The proposal is sound. I suggest adding a brief ADR (Architecture Decision Record) for future reference.`;
}

function mockCoordinatorSynthesis(_prompt: string): string {
  return `{
  "choice": "Proceed with modular approach",
  "confidence": 0.87,
  "reasoning": "Both the Tech Lead and RFC Author agree on the modular approach. The risk is low and the benefits are clear.",
  "tradeoffs": {
    "pros": ["Clean separation of concerns", "Independent testability", "Future extensibility"],
    "cons": ["Slightly more initial setup", "More files to manage"]
  }
}`;
}

function mockGenericResponse(_prompt: string): string {
  return `Analysis complete.

The requested operation has been evaluated. Based on the input parameters:
- Feasibility: High
- Estimated effort: Medium
- Risk level: Low

Proceeding with the recommended approach.

<confidence>
score: 0.85
reasoning: Standard operation with well-understood parameters.
flags: none
</confidence>`;
}
