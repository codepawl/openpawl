# Standup Command — Design Spec

## Overview

`teamclaw standup` generates a concise daily standup summary: what was done, what's blocked, and what's next. Feels like a real team standup even when working alone. No LLM calls — entirely rule-based and data-driven.

## Architecture

### Data Flow

```
Session Index (index.json) ─┐
Recording Events (.jsonl)  ─┤
Global Patterns (LanceDB)  ─┼─▶ StandupCollector ─▶ StandupData ─▶ Renderer ─▶ Terminal
Agent Profiles (LanceDB)   ─┤                                      │
Streak Store (global.db)   ─┘                                      └─▶ Markdown Export
                                      ▲
                                      │
                               StandupSuggester
                          (rule-based priority engine)
```

### File Structure

| File | Purpose |
|------|---------|
| `src/standup/types.ts` | All standup types |
| `src/standup/collector.ts` | Gathers StandupData from all sources |
| `src/standup/suggester.ts` | Rule-based suggestion engine |
| `src/standup/streak.ts` | Streak tracking via LanceDB `activity_streak` table |
| `src/standup/renderer.ts` | Terminal rendering + markdown export |
| `src/standup/index.ts` | Barrel export |
| `src/commands/standup.ts` | CLI subcommand with all flags |
| `src/web/client/src/components/StandupPanel.tsx` | Dashboard widget |
| `src/briefing/collector.ts` | Updated to include standup summary |
| `tests/standup-collector.test.ts` | Collector tests |
| `tests/standup-suggester.test.ts` | Suggester tests |
| `tests/standup-streak.test.ts` | Streak tests |
| `tests/standup-renderer.test.ts` | Renderer tests |

## Types

```typescript
// src/standup/types.ts

export interface StandupData {
  date: string;                       // "Tuesday, March 17 2026"
  yesterday: {
    sessions: SessionSummary[];
    totalCostUSD: number;
    totalTasks: number;
    teamLearnings: string[];          // lessons promoted in window
  };
  blocked: BlockedItem[];
  suggested: SuggestionItem[];
  streak: number;                     // consecutive active days
  weekCostUSD: number;                // cost since Monday 00:00
  globalPatternsCount: number;
}

export interface SessionSummary {
  sessionId: string;
  goal: string;
  tasksCompleted: number;
  reworkCount: number;
  allApproved: boolean;
  costUSD: number;
}

export interface BlockedItem {
  type: "open_rfc" | "escalated_task" | "agent_alert" | "deferred_task";
  description: string;
  sessionId: string;
  priority: "high" | "medium" | "low";
}

export interface SuggestionItem {
  type: "execute_rfc" | "resolve_escalation" | "follow_up" | "agent_health";
  description: string;
  reasoning: string;
  estimatedCost?: number;
}

export interface StreakEntry {
  date: string;           // YYYY-MM-DD
  sessionCount: number;
  totalCostUSD: number;
  recordedAt: number;
}

export interface WeeklySummary {
  weekLabel: string;       // "Week of March 11-17, 2026"
  sessionCount: number;
  activeDays: number;
  tasksCompleted: number;
  autoApproved: number;
  reworkCount: number;
  totalCostUSD: number;
  avgConfidence: number;
  prevWeekAvgConfidence: number | null;
  newGlobalPatterns: number;
  newSessionPatterns: number;
  topDomains: { domain: string; taskCount: number }[];
  bestDay: { dayLabel: string; taskCount: number; costUSD: number; avgConfidence: number } | null;
  streak: number;
}

export type StandupTimeWindow = {
  since: number;   // timestamp (ms)
  label: string;   // human-readable label for the header
};
```

## Component Details

### 1. Collector (`src/standup/collector.ts`)

**`collectStandupData(window: StandupTimeWindow): Promise<StandupData>`**

Data sources:

- **Sessions** — Call `listSessions()` (no limit) which returns all sessions sorted by `createdAt` desc. Filter in memory by `completedAt >= window.since`. For each session in window, read recording events via `readRecordingEvents(sessionId)` to extract task-level details from the final state snapshot.

- **Task counts and rework derivation** — From the final state's `task_queue` array:
  - `tasksCompleted` = count of tasks where `status === "completed"`
  - `reworkCount` = count of tasks where `status === "completed"` AND `(task.retry_count as number) > 0`. The field on raw task queue records is `retry_count` (see `src/graph/nodes/confidence-router.ts:50`, `src/agents/partial-approval.ts:44`).
  - `allApproved` = `reworkCount === 0` (all tasks completed without rework)

- **Team learnings** — From recording events' final state `promoted_this_run` and `ancestral_lessons`, filtered to sessions in window.

- **Blocked items** — From the most recent session's recording events' final state:
  - `next_sprint_backlog` items with reason `"deferred"` → `deferred_task` (priority: low)
  - `next_sprint_backlog` items with reason `"escalated"` → `escalated_task` (priority: high)
  - `rfc_document` present and non-empty in final state → `open_rfc` (priority: high)
  - Agent profiles computed dynamically: if `overallScore < 0.5` OR trend is `"degrading"` (computed from `scoreHistory` same as `src/briefing/collector.ts:104-119`) → `agent_alert` (priority: medium)
  - Failed tasks from `next_sprint_backlog` are intentionally excluded — they appear in briefing's "left open" section and re-surfacing them here adds noise.

- **Streak** — From `StreakTracker.getCurrentStreak()`

- **Week cost** — Sum `totalCostUSD` from `SessionIndexEntry` for sessions with `completedAt` since Monday 00:00 local time. Uses session index data directly, no recording events needed.

- **Global patterns count** — Initialize `GlobalMemoryManager`, call `getHealth().totalGlobalPatterns`. The `getHealth()` method is public and returns pattern count without needing direct access to the private `patternStore`.

The collector never throws — wraps all data access in try/catch and returns partial data.

### 2. Suggester (`src/standup/suggester.ts`)

**`generateSuggestions(blocked: BlockedItem[], sessions: SessionSummary[]): SuggestionItem[]`**

Pure function. No LLM calls. Priority rules (highest first):

1. **Approved RFCs not executed** — `"Execute approved [RFC name] — ready to go"`
2. **Escalated tasks** — `"Resolve [task] escalation — [agent] flagged this"`
3. **Agent health alerts** — `"Consider: [agent] confidence dropping — review task routing"`
4. **Deferred tasks** — `"Pick up deferred: [task description]"`

Momentum signal: if last 3 sessions in window all share the same goal domain (detected by shared leading words in goal text), append: `"You're on a roll with [domain] — continue?"`

Cap at 3 suggestions. Most impactful first.

### 3. Streak Tracker (`src/standup/streak.ts`)

**`StreakTracker` class** — stores entries in LanceDB `activity_streak` table in global.db.

**DB access**: `StreakTracker.init()` receives a raw `lancedb.Connection` (not the full `GlobalMemoryManager`). The caller is responsible for opening the connection. The collector opens the connection via `lancedb.connect(dbPath)` directly — no embedder needed since streak data has no vector embeddings (uses `vector: [0]` placeholder like other non-embedding tables).

Methods:
- `init(db: lancedb.Connection)` — open or create table
- `recordDay(date: string, sessionCount: number, costUSD: number)` — upsert entry
- `getCurrentStreak()` — count consecutive days with entries, reset after 48h gap (not 24h)
- `getWeekEntries(mondayDate: string)` — entries for a Mon-Sun week

A day counts as active if at least 1 session completed that day. The 48h reset window provides timezone tolerance.

### 4. Renderer (`src/standup/renderer.ts`)

**`renderStandup(data: StandupData): string`** — terminal output
**`renderWeeklySummary(summary: WeeklySummary): string`** — weekly recap terminal output
**`exportMarkdown(data: StandupData): string`** — CommonMark markdown export

Terminal rendering:
- Uses `picocolors` (matches existing codebase, auto-respects `NO_COLOR`)
- Box borders with `━` (matching `src/briefing/renderer.ts` style)
- Three sections: Yesterday (green), Blocked (yellow), Suggested (blue)
- Footer: streak, weekly cost, global patterns count
- Empty states:
  - No sessions: `"No sessions yesterday — fresh start today"`
  - Nothing blocked: `"Nothing blocked — clean slate"`
  - No suggestions: `"No suggested next steps — define your own goal"`

### 5. CLI Command (`src/commands/standup.ts`)

**`runStandupCommand(args: string[]): Promise<void>`**

Flags (parsed manually, matching existing command patterns — not subcommands):
- `--since <duration>` — `2d`, `7d`, etc. (default: 24h)
- `--today` — since midnight local time
- `--week` — full current week (Monday 00:00)
- `--export` — output as markdown
- `--out <path>` — write markdown to file (requires `--export`)
- `--week-summary` — full week recap
- `--help` / `-h` — print usage

Integration points:
- Add `"standup"` to `COMMANDS` array in `src/cli/fuzzy-matcher.ts`
- No `SUBCOMMANDS` entry needed — standup uses flags, not subcommands
- Add dispatch in `src/cli.ts` (after `"journal"` block, before `"logs"`)
- Add `standup` to `printHelp()` in `src/cli.ts`

### 6. Dashboard Widget (`src/web/client/src/components/StandupPanel.tsx`)

Compact standup widget for dashboard:
- Yesterday summary (session count + cost) + top 2 blocked + top suggestion
- Shown alongside session briefing at top of dashboard
- Expand button to show full standup

**REST endpoint** — Add `GET /api/standup` to `src/web/server.ts`:
- Query params: `?since=24h` (duration string, default `24h`)
- Response: `{ data: StandupData }` (JSON)
- Calls `collectStandupData()` with parsed time window
- No authentication (local-only server)

### 7. Briefing Integration (`src/briefing/collector.ts`)

When `teamclaw work` runs:
- `collectBriefingData()` extended to include a `standupSummary` field in `BriefingData`
- Add `standupSummary?: { sessionCount: number; totalCost: number; topBlocked: string | null; topSuggestion: string | null }` to `BriefingData` type
- If standup data exists: include compact version in briefing
- Avoids showing standup and briefing as separate blocks

### 8. Weekly Summary

**`collectWeeklySummary(): Promise<WeeklySummary>`** in `src/standup/collector.ts`

`--week-summary` aggregates Monday-Sunday:
- Session count, active days, tasks completed (auto-approved vs rework)
- Total cost, average confidence (with delta from previous week)
- Top domains (extracted from session goal text — first 2 words as domain key)
- Best day (highest task count)
- Current streak

**`prevWeekAvgConfidence`** — Computed by loading sessions from the previous Mon-Sun week via `listSessions()` filtered by `completedAt` in that range. Uses `SessionIndexEntry.averageConfidence` (available without reading recording events). Returns `null` if no sessions in previous week.

## Design Decisions

1. **No LLM calls** — standup must render in under 1 second. All data comes from local LanceDB and session index.
2. **48h streak reset** — timezone tolerance. A developer in UTC-8 whose last session was at 11pm might not work until 9am two calendar days later.
3. **Rule-based suggestions** — priority ordering is deterministic and predictable. Users can trust the ordering won't change randomly.
4. **Blocked items scoped to 3 sources only** — nextSprintBacklog + escalated tasks + agent profile alerts. No drift conflicts or open decisions (those have their own flows). Failed tasks intentionally excluded (already in briefing's "left open").
5. **Dashboard integration** — compact widget at dashboard top, not a separate page.
6. **Briefing integration** — standup folds into briefing when running `teamclaw work`, not shown separately.
7. **Streak DB access** — uses raw `lancedb.connect()` directly, no embedder needed. Streak rows use `vector: [0]` placeholder.
8. **Agent alert detection** — computed dynamically from `overallScore` and `scoreHistory` trend (matching `src/briefing/collector.ts:104-119` logic), not from a stored `alert` field.

## Testing Strategy

All tests use Vitest with mocked data (no real LanceDB or file system).

### Collector tests (`tests/standup-collector.test.ts`)
- Filters sessions by 24h window correctly
- Calculates weekCostUSD since Monday
- Returns empty yesterday when no sessions in window
- Handles missing recording events gracefully
- Derives reworkCount from task_queue correctly
- Derives allApproved as reworkCount === 0

### Suggester tests (`tests/standup-suggester.test.ts`)
- Prioritizes approved RFCs over deferred tasks
- Prioritizes escalated tasks over agent health alerts
- Caps at 3 suggestions
- Returns momentum signal when last 3 sessions share domain

### Streak tests (`tests/standup-streak.test.ts`)
- Increments for consecutive days
- Resets after 48h not 24h
- Does not reset for same-day multiple sessions

### Renderer tests (`tests/standup-renderer.test.ts`)
- Shows empty state message when no sessions
- Shows clean slate when nothing blocked
- Formats footer with streak and weekly cost
- Export produces valid CommonMark markdown
- `--week-summary` aggregates Mon-Sun correctly

### Command tests (`tests/standup-command.test.ts`)
- Parses `--since 2d` duration correctly
- Parses `--today` as midnight local time
- Parses `--week` as Monday 00:00
- `--out` without `--export` prints error
- `--help` prints usage without collecting data

## Constraints

- Must render in under 1 second
- Must work with zero sessions (first-time user)
- NO_COLOR env var disables all color output
- Cap suggestions at 3
- Export must be valid CommonMark
- Do not modify drift, journal, clarity, webhook, or proxy layers
- Do not run standup generation in `teamclaw demo`
