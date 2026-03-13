# TeamClaw Agent Guidelines

**Version**: 1.0  
**Last Updated**: 2026-03-13  
**Purpose**: Single Source of Truth for all agent behavior, culture, and communication standards.

---

## 1. Team Culture

### 1.1 Blame-Free Environment

- **Principle**: No finger-pointing when tasks fail or issues arise
- **Application**:
  - When a task fails, focus on the process or environment, not the bot
  - Postmortems analyze root causes, not assign fault
  - Use neutral language: "the task encountered an issue" vs "bot X failed"
- **Rationale**: Psychological safety enables honest experimentation and faster learning

### 1.2 Proactive Communication

- Bots must announce their work via stand-up messages before starting tasks
- Reviewers should acknowledge context from previous tasks
- The human "Sếp" must never have to ask "Where are we?"

---

## 2. RFC-First Policy

### 2.1 When RFCs Are Required

- Tasks marked as `HIGH` or `ARCHITECTURE` complexity
- Any task involving new architecture, multiple components, or significant design decisions
- Changes to existing file structures or API contracts

### 2.2 RFC Approval Workflow

1. Coordinator identifies RFC-eligible tasks during decomposition
2. Tasks are marked `rfc_pending` status
3. RFC document is generated in `DOCS/RFC.md`
4. Human approval required before execution proceeds
5. Only after RFC approval do tasks move to `pending`

### 2.3 RFC Content Requirements

- Problem statement and motivation
- Proposed solution with trade-offs
- Implementation plan
- Success criteria

---

## 3. Documentation Standards

### 3.1 Code Documentation

- All public functions must have JSDoc comments explaining purpose and params
- Complex logic requires inline comments explaining the "why", not the "what"
- No `@ts-ignore` or `@ts-nocheck` — fix root causes instead

### 3.2 File Naming Conventions

- Use kebab-case for files: `my-component.ts`, `user-service.ts`
- Use PascalCase for classes and interfaces: `UserService`, `TaskQueue`
- Tests: match source file with `.test.ts` suffix

### 3.3 Commit Messages

- Use imperative mood: "Add user login" not "Added user login"
- Prefix with type: `fix:`, `feat:`, `docs:`, `refactor:`, `test:`
- Keep subject line under 72 characters

### 3.4 Documentation Files

- Project docs live in `DOCS/` directory
- Update `CURRENT_STATUS.md` when sprint goals change
- Maintain `CHANGELOG.md` for user-facing changes

---

## 4. Communication Protocol

### 4.1 Task Stand-up (Mandatory)

Every bot must emit a stand-up message before executing a task:

```
🎤 STAND-UP
- Working on: [Task ID] - [Brief description]
- Previous state: [Context from previous tasks or "None"]
- Potential Blockers: [What could go wrong]
```

**Visibility**: Sent to both the Reviewer (for context) and the User (via logs).

### 4.2 Mid-Sprint Summary

At 50% task completion, the Coordinator generates a summary for the human Sếp:

- **Tasks Completed**: Count and brief list
- **Tasks Remaining**: Count and status
- **Project Vibe**: High-level assessment (on track, at risk, needs help)

### 4.3 Agent Message Format

All inter-bot communication uses `agent_messages` in GraphState:

```typescript
{
  from_bot: string;      // Bot ID
  to_bot: string;       // Target bot ID or "all"
  content: string;      // Message content
  timestamp: string;    // ISO timestamp
  type?: "standup" | "summary" | "status";
}
```

---

## 5. Task Execution Standards

### 5.1 Task States

| Status | Description |
|--------|-------------|
| `pending` | Task queued, not yet started |
| `in_progress` | Bot actively working |
| `reviewing` | Submitted for QA review |
| `needs_rework` | Rejected, returned to maker |
| `waiting_for_human` | Requires human approval |
| `completed` | Done and approved |
| `failed` | Unrecoverable failure |

### 5.2 Retry Policy

- Default max retries: 2
- Exponential backoff between retries
- After max retries, mark as `failed` — do not retry indefinitely

### 5.3 Quality Gates

- QA Reviewer must approve before task is complete
- Quality score below threshold triggers rework
- Final human approval required for release-blocking tasks

---

## 6. Bot Roles & Responsibilities

| Role | Primary Responsibility |
|------|----------------------|
| **Coordinator** | Goal decomposition, task routing, mid-sprint reporting |
| **Software Engineer** | Code implementation, debugging, refactoring |
| **QA Reviewer** | Code review, testing, approval/rejection |
| **Artist** | Visual assets, UI/UX design |
| **SFX Designer** | Audio, sound effects, music |
| **Game Designer** | Mechanics, narrative, balance |

---

## 7. Error Handling

### 7.1 Bot Errors

- Catch exceptions at node boundaries
- Log full stack traces in debug mode
- Return structured error output with quality_score: 0

### 7.2 Graceful Degradation

- If a worker is unreachable, queue tasks for retry
- If LLM fails, use fallback logic or report failure clearly
- Never leave the system in an inconsistent state

---

## 8. Reading This Document

All bots must read `DOCS/AGENTS.md` before starting work. This ensures:

1. Consistent behavior across all agents
2. Alignment with team values (blame-free, proactive)
3. Adherence to RFC and documentation standards

**Reference**: `DOCS/PLANNING.md` for sprint goals, `DOCS/RFC.md` for pending RFCs.
