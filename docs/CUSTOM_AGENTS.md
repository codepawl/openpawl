# Custom Agents SDK

Define custom agent roles and plug them into TeamClaw's orchestration graph without modifying internals.

## Quick Start

### 1. Define an agent

Create a file (e.g. `my-agent.ts`):

```typescript
import { defineAgent } from "@teamclaw/sdk";

export default defineAgent({
  role: "code-reviewer",
  displayName: "Code Reviewer",
  description: "Reviews code for quality, best practices, and security issues",
  taskTypes: ["review", "audit", "verify"],
  systemPrompt: `You are an expert code reviewer. When given a task:
1. Read all relevant source files
2. Check for bugs, security issues, and style violations
3. Provide actionable feedback with specific line references
4. Suggest improvements with code examples`,
  compositionRules: {
    includeKeywords: ["review", "audit", "quality", "code review"],
    excludeKeywords: ["prototype", "draft"],
  },
  confidenceConfig: {
    minConfidence: 0.7,
    flags: ["style-violation", "security-concern"],
  },
});
```

### 2. Register the agent

```bash
teamclaw agent add ./my-agent.ts
```

### 3. Use it

The agent participates in work sessions automatically. The coordinator assigns tasks to it based on task types and the composition rules determine when it's included.

```bash
teamclaw work --goal "Review the authentication module for security issues"
```

## API Reference

### `defineAgent(definition: AgentDefinition): ValidatedAgentDefinition`

Validates and brands a custom agent definition. Returns a frozen, branded object.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `role` | `string` | Unique kebab-case identifier (e.g. `"code-reviewer"`) |
| `displayName` | `string` | Human-readable name |
| `description` | `string` | What the agent does |
| `taskTypes` | `string[]` | Task types this agent handles |
| `systemPrompt` | `string` | System prompt for LLM interactions |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `confidenceConfig` | `ConfidenceConfig` | Confidence scoring settings |
| `compositionRules` | `CompositionRules` | Auto-inclusion rules |
| `hooks` | `AgentHooks` | Lifecycle hooks |
| `metadata` | `Record<string, unknown>` | Arbitrary metadata |

### Types

```typescript
interface ConfidenceConfig {
  minConfidence?: number;   // 0-1, tasks below this trigger rework
  flags?: string[];         // Custom confidence flags
}

interface CompositionRules {
  includeKeywords?: string[];     // Goal keywords triggering inclusion
  excludeKeywords?: string[];     // Goal keywords suppressing inclusion
  minComplexityScore?: number;    // Minimum complexity to include
  required?: boolean;             // Always include regardless of keywords
}

interface AgentHooks {
  beforeTask?: (task, context) => Promise<task>;
  afterTask?: (result, context) => Promise<result>;
  onError?: (error, context) => Promise<void>;
}

interface AgentContext {
  sessionId: string;
  taskId: string;
  runIndex: number;
  proxyUrl: string;
  config: Record<string, unknown>;
}
```

## CLI Commands

```bash
# Register from file
teamclaw agent add ./my-agent.ts

# Register all agents in a directory
teamclaw agent add ./agents/

# List registered agents
teamclaw agent list

# Show agent details
teamclaw agent show code-reviewer

# Remove an agent
teamclaw agent remove code-reviewer

# Validate without registering
teamclaw agent validate ./my-agent.ts
```

## How Custom Agents Work

Custom agents are **worker-type agents**. They participate in the existing `worker_task -> confidence_router -> worker_collect` pipeline:

1. **Registration**: `teamclaw agent add` validates, compiles (if TypeScript), and stores the definition in `~/.teamclaw/agents/`
2. **Loading**: At graph construction, `TeamOrchestration` loads registered agents and creates `WorkerBot` instances
3. **Composition**: In autonomous mode, composition rules determine if the agent is included based on goal keywords
4. **Dispatch**: The coordinator assigns tasks to custom agents based on task types. The dispatcher fans them out to `worker_task` nodes
5. **Execution**: The custom agent's system prompt is used instead of the default worker prompt

### Lifecycle Hooks

Hooks wrap the adapter's `executeTask()` method:

```typescript
export default defineAgent({
  // ...
  hooks: {
    beforeTask: async (task, context) => {
      // Transform task before execution
      console.log(`Starting task ${context.taskId}`);
      return task;
    },
    afterTask: async (result, context) => {
      // Transform result after execution
      return result;
    },
    onError: async (error, context) => {
      // Handle errors
      console.error(`Task ${context.taskId} failed:`, error.message);
    },
  },
});
```

## Composition Rules

When autonomous team composition is enabled (`--team autonomous`), custom agents are included/excluded based on goal analysis:

- **includeKeywords**: If the goal contains any of these words, the agent is included. More keyword matches = higher confidence.
- **excludeKeywords**: These words reduce the inclusion score. If negative keywords outweigh positive ones, the agent is excluded.
- **required**: If `true`, the agent is always included regardless of keywords.

Confidence is calculated as: `min(0.5 + matchCount * 0.15, 0.95)`

## Multiple Agents

Export an array for multiple agents in one file:

```typescript
import { defineAgent } from "@teamclaw/sdk";

export default [
  defineAgent({
    role: "code-reviewer",
    displayName: "Code Reviewer",
    description: "Reviews code quality",
    taskTypes: ["review"],
    systemPrompt: "You are a code reviewer.",
  }),
  defineAgent({
    role: "security-auditor",
    displayName: "Security Auditor",
    description: "Audits for security vulnerabilities",
    taskTypes: ["audit", "security"],
    systemPrompt: "You are a security auditor.",
  }),
];
```

## Publishing as npm Package

Create a package with a default export:

```json
{
  "name": "teamclaw-agent-code-reviewer",
  "main": "dist/index.js",
  "type": "module",
  "peerDependencies": {
    "@teamclaw/sdk": "^0.0.1"
  }
}
```

```typescript
// src/index.ts
import { defineAgent } from "@teamclaw/sdk";

export default defineAgent({
  role: "code-reviewer",
  // ...
});
```

## Web Dashboard

Custom agents appear in **Settings > Agents** tab in the web dashboard. You can view registered agents and remove them from the UI.

## Storage

Registered agents are stored at:
- `~/.teamclaw/agents/registry.json` — Agent registry index
- `~/.teamclaw/agents/custom/<role>.mjs` — Compiled agent modules
- `~/.teamclaw/agents/custom/<role>.json` — Serialized definitions (without hooks)

## Constraints

- Role must be kebab-case (e.g. `code-reviewer`, not `codeReviewer`)
- Role cannot collide with built-in agent roles (`coordinator`, `worker_task`, etc.)
- Role cannot collide with built-in role templates (`software_engineer`, `qa_reviewer`, etc.)
- At least one task type is required
- System prompt is required
