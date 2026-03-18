# Think Command (Rubber Duck Mode) Design Spec

## Problem

Users need to think through hard decisions without starting a full sprint. They want structured debate between agent perspectives, a clear recommendation with tradeoffs, and the decision saved to the journal — without executing any code or burning a sprint budget.

## Solution

`teamclaw think` — a lightweight structured thinking mode that debates a question between Tech Lead and RFC Author perspectives, synthesizes a recommendation via Coordinator, and optionally saves to the decision journal.

## Architecture

### Data Flow

```
User question
  → Context loader (journal decisions, patterns, profiles) [async, <500ms]
  → Tech Lead perspective [ProxyService.stream()]
  → RFC Author perspective [ProxyService.stream()]
  → Coordinator synthesis [ProxyService.stream()]
  → Recommendation displayed
  → User action: Save / Follow-up / Sprint handoff / Discard
```

### Key Design Decisions

1. **CLI mode uses `ProxyService` directly; dashboard uses HTTP endpoint.** No fighting the existing architecture — CLI doesn't require the web server.
2. **Direct `Decision` mapping first, extractor as fallback.** Structured `ThinkRecommendation` maps cleanly to `Decision`; text extraction is a fallback for edge cases.
3. **Context loading is async with loading indicator.** Cold start (VectorMemory + GlobalMemoryManager + embedder init) can exceed 500ms; show "Checking past decisions..." while loading.
4. **No LangGraph graph.** Direct sequential ProxyService calls only.
5. **Max 3 follow-up rounds per session.**

## Types

```typescript
// src/think/types.ts

type ThinkSession = {
  id: string;
  question: string;
  context: ThinkContext;
  rounds: ThinkRound[];
  recommendation: ThinkRecommendation | null;  // always mirrors latest round's recommendation
  savedToJournal: boolean;
  createdAt: number;
};

type ThinkContext = {
  relevantDecisions: Decision[];   // from journal, max 3
  relevantPatterns: string[];      // from global memory, max 2
  agentProfiles: {
    techLead: AgentProfile | null;
    rfcAuthor: AgentProfile | null;
  };
};

type ThinkRound = {
  question: string;                // original or follow-up
  techLeadPerspective: string;
  rfcAuthorPerspective: string;
  recommendation: ThinkRecommendation;
};

type ThinkRecommendation = {
  choice: string;                  // the recommended option
  confidence: number;              // 0-1
  reasoning: string;
  tradeoffs: {
    pros: string[];
    cons: string[];
  };
};

type ThinkHistoryEntry = {
  sessionId: string;
  question: string;
  recommendation: string;
  confidence: number;
  savedToJournal: boolean;
  followUpCount: number;
  createdAt: number;
};
```

### Decision Field Mapping

When saving a `ThinkRecommendation` to the decision journal, fields map as follows:

| Decision field | Source |
|----------------|--------|
| `id` | `randomUUID()` |
| `sessionId` | `ThinkSession.id` (prefixed `think-`) |
| `runIndex` | `0` (think sessions have no runs) |
| `capturedAt` | `Date.now()` |
| `topic` | Extracted from `recommendation.choice` (first 4 words) |
| `decision` | `recommendation.choice` |
| `reasoning` | `recommendation.reasoning` |
| `recommendedBy` | `"coordinator"` |
| `confidence` | `recommendation.confidence` |
| `taskId` | `""` (no task in think mode) |
| `goalContext` | `ThinkSession.question` |
| `tags` | Extracted via existing `extractTags()` from extractor |
| `embedding` | `[]` (populated by store on upsert if embedder available) |
| `status` | `"active"` |

## File Structure

| File | Purpose |
|------|---------|
| `src/think/types.ts` | All think types |
| `src/think/session.ts` | ThinkSession orchestrator |
| `src/think/prompts.ts` | Tech Lead, RFC Author, Coordinator prompts |
| `src/think/executor.ts` | ProxyService streaming calls |
| `src/think/context-loader.ts` | Journal + memory + profile loading |
| `src/think/history.ts` | ThinkHistoryEntry, global.db storage |
| `src/think/index.ts` | Barrel export |
| `src/commands/think.ts` | CLI subcommand handler |

### Files to Update

| File | Change |
|------|--------|
| `src/cli.ts` | Add `think` command branch |
| `src/cli/fuzzy-matcher.ts` | Add `think` to COMMANDS, subcommands |
| `src/web/server.ts` | Add `POST /api/think` and `POST /api/think/:sessionId/followup` SSE endpoints |
| `src/web/client/src/components/ThinkPanel.tsx` | Dashboard panel (new file) |
| `src/briefing/collector.ts` | Surface recent think sessions |

## Prompts

### Tech Lead

```
You are TeamClaw's Tech Lead. Your role is to give a pragmatic,
implementation-focused perspective on this question.

Past decisions relevant to this question:
{decisionContext}

Question: {question}

Give your perspective in 3-5 sentences. Focus on practical
implementation concerns, complexity, and consistency with
existing decisions. Be direct and opinionated.
End with your recommended choice in one sentence.
```

### RFC Author

```
You are TeamClaw's RFC Author. Your role is to consider
longer-term architectural implications and edge cases.

Past decisions relevant to this question:
{decisionContext}

Question: {question}

Give your perspective in 3-5 sentences. Focus on future
flexibility, architectural consistency, and risks.
Be direct and opinionated.
End with your recommended choice in one sentence.
```

### Coordinator Synthesis

```
You are TeamClaw's Coordinator. Two experts have weighed in:

Tech Lead: {techLeadPerspective}
RFC Author: {rfcAuthorPerspective}

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
  "tradeoffs": { "pros": [...], "cons": [...] }
}
```

**JSON parsing:** The executor must handle common LLM quirks: strip markdown code fences (`` ```json ... ``` ``), trim whitespace, extract the first `{...}` block if extra text is present. Use the existing `extractJson()` utility from `src/utils/json-extract.ts` if available, otherwise implement a simple fence-stripper.

### Follow-up Prompt Addition

For follow-up rounds, prepend to both Tech Lead and RFC Author prompts:

```
Previous discussion:
{previousRounds as formatted summary}

Follow-up question: {followUpQuestion}
```

## Executor

### CLI Mode

- Uses `ProxyService.stream()` directly
- Three sequential calls: Tech Lead -> RFC Author -> Coordinator
- Streams each response live to terminal as chunks arrive
- On single agent failure: show partial results, allow retry

### Dashboard Mode

- `POST /api/think` endpoint streams SSE events:

```typescript
{ event: 'context_loaded', data: { relevantDecisions: number } }
{ event: 'tech_lead_start', data: {} }
{ event: 'tech_lead_chunk', data: { content: string } }
{ event: 'tech_lead_done', data: { perspective: string } }
{ event: 'rfc_author_start', data: {} }
{ event: 'rfc_author_chunk', data: { content: string } }
{ event: 'rfc_author_done', data: { perspective: string } }
{ event: 'recommendation', data: { recommendation: ThinkRecommendation } }
{ event: 'error', data: { stage: string, message: string } }
{ event: 'done', data: {} }
```

### Dashboard Follow-up

Follow-up questions use a separate endpoint:
- `POST /api/think/:sessionId/followup` with `{ question: string }`
- Returns same SSE event stream as initial think
- Server maintains active think sessions in memory (Map<string, ThinkSession>)
- Sessions expire after 30 minutes of inactivity

## Context Loader

1. Query decision journal for relevant past decisions (max 3)
2. Query global success patterns for relevant approaches (max 2)
3. Load Tech Lead and RFC Author profiles
4. All three queries run concurrently via `Promise.all`
5. Loading indicator shown while context loads

## Journal Save

When user chooses "Save to decision journal":
1. Map `ThinkRecommendation` directly to `Decision` object using the field mapping table above
2. Fallback: if Coordinator returned raw text instead of valid JSON, pass the raw text through `extractDecisions()` with `agentRole: "coordinator"`, `sessionId: session.id`, `runIndex: 0`, `goalContext: session.question`
3. Save with `recommendedBy: 'coordinator'`, confidence from recommendation
4. Show confirmation: "Decision saved: [choice]"

## Sprint Handoff

When user chooses "Start a sprint based on this decision":
1. Save decision to journal first
2. Launch `teamclaw work` with the question as context
3. Pre-populate goal suggestion: "Implement: [recommendation.choice]"

## CLI Interface

```bash
teamclaw think "your question here"        # interactive think session
teamclaw think "question" --save           # auto-save to journal
teamclaw think "question" --no-stream      # show results at end
teamclaw think history                     # list past think sessions
teamclaw think history --session <id>      # show specific session
```

## Think History

- Stored in global.db `think_history` table (LanceDB)
- LanceDB requires a vector column — use `vector: [0]` dummy vector (same pattern as `ClarityHistoryStore`)
- Survives `teamclaw clean` (clean only removes global memory with `--include-global`, no change needed)
- Surfaced in session briefing: "You thought about X recently — decision saved"

## Requirements

- Think session completes in under 30 seconds total
- Context loading completes in under 500ms (after warm-up)
- Streaming output appears live — not buffered
- Max 3 follow-up rounds per session
- Works without dashboard — CLI only mode fully supported
- Works without an active sprint or session
- `--save` flag skips the action prompt entirely
- `--save` and `--no-stream` can be combined (buffer output, auto-save, no prompts — useful for scripting)

## Constraints

- No LangGraph graph for think sessions — direct proxy calls only
- No new LLM client instance — use ProxyService only
- No modifications to drift, journal, clarity, standup, or proxy layers
- Not included in `teamclaw demo` command

## Tests

Test files:
- `tests/think-session.test.ts`
- `tests/think-prompts.test.ts`
- `tests/think-executor.test.ts`
- `tests/think-context-loader.test.ts`
- `tests/think-history.test.ts`

Coverage:
- Session correctly builds context from journal and memory
- Session correctly sequences Tech Lead -> RFC Author -> Coordinator
- Prompts correctly inject decision context
- Prompts correctly inject previous rounds for follow-ups
- Executor streams chunks correctly from ProxyService
- Executor returns partial results on single agent failure
- Context loader returns max 3 decisions and 2 patterns
- Context loader completes in under 500ms with mocked data
- Follow-up correctly appends new ThinkRound to session
- Follow-up cap enforced at 3 rounds
- Journal save maps recommendation directly to Decision
- Journal save falls back to extractor on mapping failure
- Sprint handoff pre-populates goal from recommendation choice
- History stores and retrieves correctly
- `--save` flag skips action prompt
