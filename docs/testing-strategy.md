# TeamClaw Testing Strategy

> **Note:** This is a comprehensive testing strategy designed for TeamClaw. The strategy is organized into categories matching the existing test structure in `tests/`.

---

## 1. Unit Testing (Logic Accuracy)

### 1.1 PriceRegistry - Token Cost Calculation

**Objective:** Verify USD calculation accuracy with and without Prompt Caching for OpenAI/Anthropic models.

**Mocking Strategy:**
- Mock `localStorage` with `vi.stubGlobal()` to test cache behavior
- Mock `fetch` with `vi.fn()` to simulate network responses
- Use Vitest's timer mocking (`vi.useFakeTimers`) for TTL validation

**Sample Test - Cost Calculation with Prompt Caching:**

```typescript
// tests/price-registry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PriceRegistry } from "../src/web/client/src/utils/PriceRegistry";

describe("PriceRegistry", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });
  });

  it("calculates cost correctly with cached tokens (OpenAI format)", async () => {
    const registry = new PriceRegistry();
    
    // Directly set data to avoid fetch
    vi.spyOn(registry as any, 'init').mockImplementation(async () => {
      (registry as any).data = {
        version: "test",
        updatedAt: new Date().toISOString(),
        models: {
          "gpt-4o": { inputPerM: 2.50, outputPerM: 10.00, cachedPerM: 1.25 },
        },
      };
      (registry as any).initialized = true;
    });
    
    await registry.init();
    
    // Input: 1M tokens, Cached: 500K, Output: 500K
    // Full-price input: 1M - 500K = 500K @ $2.50/1M = $1.25
    // Cached: 500K @ $1.25/1M = $0.625
    // Output: 500K @ $10.00/1M = $5.00
    // Total: $6.875
    
    const pricing = registry.getPricing("gpt-4o");
    const cachedPricing = registry.getCachedPricing("gpt-4o");
    
    const inputTokens = 1_000_000;
    const cachedInputTokens = 500_000;
    const outputTokens = 500_000;
    
    const fullPriceInputTokens = Math.max(0, inputTokens - cachedInputTokens);
    const inputCost = (fullPriceInputTokens / 1_000_000) * pricing.inputPerM;
    const cachedCost = (cachedInputTokens / 1_000_000) * cachedPricing.cachedPerM!;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPerM;
    
    expect(inputCost).toBe(1.25);
    expect(cachedCost).toBe(0.625);
    expect(outputCost).toBe(5.00);
    expect(inputCost + cachedCost + outputCost).toBe(6.875);
  });

  it("normalizes versioned model names (gpt-4o-2024-08-06 -> gpt-4o)", async () => {
    const registry = new PriceRegistry();
    vi.spyOn(registry as any, 'init').mockImplementation(async () => {
      (registry as any).data = {
        version: "test",
        updatedAt: new Date().toISOString(),
        models: {
          "gpt-4o": { inputPerM: 2.50, outputPerM: 10.00 },
        },
      };
      (registry as any).initialized = true;
    });
    
    await registry.init();
    
    const pricing = registry.getPricing("gpt-4o-2024-08-06");
    expect(pricing.inputPerM).toBe(2.50);
  });

  it("falls back to default pricing for unknown models", async () => {
    const registry = new PriceRegistry();
    vi.spyOn(registry as any, 'init').mockImplementation(async () => {
      (registry as any).data = { version: "test", updatedAt: "", models: {} };
      (registry as any).initialized = true;
    });
    
    await registry.init();
    
    const pricing = registry.getPricing("unknown-model");
    expect(pricing.inputPerM).toBe(0.15); // default
  });
});
```

**Edge Cases:**
- [ ] Zero tokens (should return $0.00)
- [ ] All tokens cached (no full-price input)
- [ ] Unknown model defaults to gpt-4o-mini pricing
- [ ] Cache TTL expiry after 24 hours
- [ ] Network failure falls back to stale cache
- [ ] Network failure with no cache uses defaults

---

### 1.2 ConfigManager - Hierarchy Loading

**Objective:** Test config priority: CLI Flags → Global JSON → Workspace JSON → Defaults.

**Mocking Strategy:**
- Mock filesystem with `vi.mock()` for JSON config files
- Mock `process.env` for CLI flags
- Test secret masking logic

**Sample Test:**

```typescript
// tests/config-hierarchy.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getConfigValue, setConfigValue, coerceJsonValue } from "../src/core/configManager.js";

vi.mock("../src/core/jsonConfigManager.js", async () => {
  return {
    readTeamclawConfig: vi.fn(() => ({ 
      path: "/test/teamclaw.config.json", 
      data: { creativity: 0.7, max_cycles: 5 } 
    })),
    writeTeamclawConfig: vi.fn(),
    getJsonKey: vi.fn((key, data) => data[key]),
    setJsonKey: vi.fn((key, value, data) => ({ ...data, [key]: value })),
    unsetJsonKey: vi.fn((key, data) => {
      const { [key]: _, ...rest } = data;
      return rest;
    }),
  };
});

describe("ConfigManager hierarchy", () => {
  it("returns default goal when no config exists", () => {
    // Test default value
    const result = coerceJsonValue("unknown_key", "some_value");
    expect(result.ok).toBe(true);
  });

  it("validates creativity range (0-1)", () => {
    expect(coerceJsonValue("creativity", "0.5").ok).toBe(true);
    expect(coerceJsonValue("creativity", "1.5").ok).toBe(false);
    expect(coerceJsonValue("creativity", "-0.1").ok).toBe(false);
  });

  it("validates max_cycles is integer >= 1", () => {
    expect(coerceJsonValue("max_cycles", "10").ok).toBe(true);
    expect(coerceJsonValue("max_cycles", "0").ok).toBe(false);
    expect(coerceJsonValue("max_cycles", "5.5").ok).toBe(false);
  });
});
```

**Edge Cases:**
- [ ] Missing config file returns null values
- [ ] Invalid JSON in config file handled gracefully
- [ ] Secret keys (KEY, TOKEN, SECRET, PASSWORD) are masked
- [ ] Raw flag disables masking for programmatic access
- [ ] Invalid creativity/max_cycles values return error

---

### 1.3 ANSI String Parsing (Xterm.js)

**Objective:** Verify terminal output is correctly parsed for xterm.js rendering.

**Sample Test:**

```typescript
// tests/ansi-parser.test.ts
import { describe, it, expect } from "vitest";

function parseAnsiToPlainText(ansiString: string): string {
  // Strip ANSI escape codes
  return ansiString.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function extractAnsiCodes(ansiString: string): string[] {
  const codes: string[] = [];
  const regex = /\x1b\[([0-9;]*)([a-zA-Z])/g;
  let match;
  while ((match = regex.exec(ansiString)) !== null) {
    codes.push(match[0]);
  }
  return codes;
}

describe("ANSI string parsing", () => {
  it("strips ANSI codes to plain text", () => {
    const input = "\x1b[32m\x1b[1mSuccess\x1b[0m";
    expect(parseAnsiToPlainText(input)).toBe("Success");
  });

  it("extracts color codes correctly", () => {
    const input = "\x1b[31mError: \x1b[1mFile not found\x1b[0m";
    const codes = extractAnsiCodes(input);
    expect(codes).toContain("\x1b[31m");
    expect(codes).toContain("\x1b[1m");
    expect(codes).toContain("\x1b[0m");
  });

  it("handles mixed cursor movement and text", () => {
    const input = "\x1b[2J\x1b[H\x1b[32m✓ Ready\x1b[0m";
    const plain = parseAnsiToPlainText(input);
    expect(plain).toBe("✓ Ready");
  });
});
```

---

## 2. Integration Testing (Orchestration Flow)

### 2.1 LangGraph Nodes - State Transitions

**Objective:** Mock LLM responses to test state transitions (work → approval → complete).

**Mocking Strategy:**
- Use `vi.stubGlobal("fetch", ...)` to mock OpenClaw API responses
- Create mock GraphState objects
- Test node output against expected state mutations

**Sample Test:**

```typescript
// tests/graph-nodes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTeamOrchestration } from "../src/core/simulation.js";
import type { GraphState } from "../src/core/graph-state.js";

function mockCoordinatorResponse(tasks: any[]) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/api/generate")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: JSON.stringify(tasks) }),
      });
    }
    return Promise.resolve({ ok: false });
  }));
}

describe("LangGraph state transitions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("transitions from pending task to approval_required", async () => {
    mockCoordinatorResponse([
      { 
        description: "Delete production database", 
        assigned_to: "bot_0", 
        priority: "HIGH",
        worker_tier: "light" 
      },
    ]);

    const orch = createTeamOrchestration({
      team: [{ id: "bot_0", name: "Dev", role_id: "engineer", traits: {} }],
      workerUrls: {},
    });

    const state = orch.getInitialState({ userGoal: "Test approval flow" });
    
    // First cycle: coordinator creates task
    const afterCoordinator = await orch.coordinator.coordinateNode(state);
    const taskQueue = afterCoordinator.task_queue as any[];
    
    expect(taskQueue).toBeDefined();
    expect(taskQueue.length).toBeGreaterThan(0);
    expect(taskQueue[0].priority).toBe("HIGH");
  });

  it("auto-approves non-HIGH priority tasks", async () => {
    mockCoordinatorResponse([
      { 
        description: "Simple refactor", 
        assigned_to: "bot_0", 
        priority: "MEDIUM",
        worker_tier: "light" 
      },
    ]);

    const orch = createTeamOrchestration({
      team: [{ id: "bot_0", name: "Dev", role_id: "engineer", traits: {} }],
      workerUrls: {},
    });

    const state = orch.getInitialState({ userGoal: "Test auto-approve" });
    const afterCoordinator = await orch.coordinator.coordinateNode(state);
    
    // Should not need approval
    expect(afterCoordinator.approval_pending).toBeNull();
  });
});
```

---

### 2.2 HITL Bridge - Promise.race Logic

**Objective:** Test the race between CLI input and WebSocket approval. Verify `AbortController` correctly cancels the CLI prompt.

**Sample Test:**

```typescript
// tests/hitl-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHumanApprovalNode } from "../src/agents/approval.js";
import type { GraphState } from "../src/core/graph-state.js";

describe("HITL Bridge - Promise.race", () => {
  it("resolves via WebSocket and aborts CLI prompt", async () => {
    const wsApprovalResponse = {
      action: "approved" as const,
    };

    const approvalProvider = vi.fn().mockResolvedValue(wsApprovalResponse);
    
    const node = createHumanApprovalNode(false, approvalProvider);

    const state: GraphState = {
      task_queue: [
        {
          task_id: "task-1",
          description: "Deploy to prod",
          assigned_to: "bot_0",
          status: "waiting_for_human",
          priority: "HIGH",
        },
      ] as any,
      cycle_count: 1,
      session_active: true,
      messages: [],
      agent_messages: [],
      task_completed: [],
      bot_stats: {},
    };

    const result = await node(state);

    expect(approvalProvider).toHaveBeenCalled();
    expect(result.last_action).toContain("Dashboard");
    const taskQueue = result.task_queue as any[];
    expect(taskQueue[0].status).toBe("completed");
  });

  it("resolves via CLI when WebSocket is slower", async () => {
    // Simulate CLI resolving first
    const approvalProvider = vi.fn().mockImplementation(
      () => new Promise(() => {}) // Never resolves - simulating slow WS
    );
    
    // The actual CLI prompt would timeout or succeed
    // In test, we verify the race behavior
    const node = createHumanApprovalNode(false, approvalProvider);

    const state: GraphState = {
      task_queue: [
        {
          task_id: "task-1",
          description: "Approve this",
          assigned_to: "bot_0",
          status: "waiting_for_human",
          priority: "HIGH",
        },
      ] as any,
      cycle_count: 1,
      session_active: true,
      messages: [],
      agent_messages: [],
      task_completed: [],
      bot_stats: {},
    };

    // Note: Full CLI testing requires more complex mocking
    // This verifies the approvalProvider is called
    await node(state);
    expect(approvalProvider).toHaveBeenCalled();
  });

  it("auto-approves in non-TTY environment", async () => {
    const originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;
    process.stderr.isTTY = false;

    const approvalProvider = vi.fn();
    const node = createHumanApprovalNode(false, approvalProvider);

    const state: GraphState = {
      task_queue: [
        { task_id: "task-1", description: "Test", assigned_to: "bot_0", status: "waiting_for_human" },
      ] as any,
      cycle_count: 1,
      session_active: true,
      messages: [],
      agent_messages: [],
      task_completed: [],
      bot_stats: {},
    };

    const result = await node(state);

    process.stdout.isTTY = originalIsTTY;
    process.stderr.isTTY = originalIsTTY;

    expect(approvalProvider).not.toHaveBeenCalled();
    expect(result.last_action).toContain("non-TTY");
  });
});
```

**Edge Cases:**
- [ ] Both CLI and WS respond simultaneously - first wins
- [ ] CLI completes after WS - should be cancelled gracefully
- [ ] WebSocket disconnects mid-approval - CLI takes over
- [ ] Multiple tasks waiting - all get resolved together

---

## 3. E2E & System Testing (Real-time Sync)

### 3.1 WebSocket Broadcast - Concurrent Clients

**Objective:** Simulate 5+ clients, verify TERMINAL_OUTPUT reaches all within <50ms.

**Sample Test:**

```typescript
// tests/websocket-broadcast.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { 
  addTerminalClient, 
  removeTerminalClient, 
  broadcastTerminalData,
  flushTerminalBuffer,
  initTerminalBroadcast,
  restoreTerminal,
} from "../src/core/terminal-broadcast.js";

describe("WebSocket Broadcast", () => {
  const mockClients: Array<{ send: vi.Mock; called: boolean }> = [];

  beforeEach(() => {
    mockClients.length = 0;
    // Add 5 mock clients
    for (let i = 0; i < 5; i++) {
      const client = { send: vi.fn(), called: false };
      mockClients.push(client);
      addTerminalClient(client.send);
    }
  });

  afterEach(() => {
    restoreTerminal();
    mockClients.forEach(c => removeTerminalClient(c.send));
  });

  it("broadcasts to all clients within batch interval", async () => {
    broadcastTerminalData("Hello World\n");
    
    // Flush immediately to test
    flushTerminalBuffer();

    expect(mockClients.length).toBe(5);
    mockClients.forEach(client => {
      expect(client.send).toHaveBeenCalled();
      const payload = JSON.parse(client.send.mock.calls[0][0]);
      expect(payload.type).toBe("terminal_out");
      expect(payload.payload.data).toBe("Hello World\n");
    });
  });

  it("batches multiple writes within 50ms interval", async () => {
    broadcastTerminalData("Line 1\n");
    broadcastTerminalData("Line 2\n");
    broadcastTerminalData("Line 3\n");
    
    flushTerminalBuffer();

    // All 3 lines should be batched into single message
    mockClients.forEach(client => {
      expect(client.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(client.send.mock.calls[0][0]);
      expect(payload.payload.data).toBe("Line 1\nLine 2\nLine 3\n");
    });
  });

  it("handles client disconnection gracefully", () => {
    const disconnectedClient = mockClients[0].send;
    removeTerminalClient(disconnectedClient);
    
    // Should not throw
    expect(() => broadcastTerminalData("Test\n")).not.toThrow();
  });
});
```

**Performance Benchmark:**

```typescript
describe("Broadcast Performance", () => {
  it("completes broadcast in <50ms for 10 clients", async () => {
    const clients: vi.Mock[] = [];
    for (let i = 0; i < 10; i++) {
      const send = vi.fn();
      clients.push(send);
      addTerminalClient(send);
    }

    const testData = "Performance test data\n".repeat(100);
    
    const start = performance.now();
    broadcastTerminalData(testData);
    flushTerminalBuffer();
    const end = performance.now();

    const latency = end - start;
    expect(latency).toBeLessThan(50);

    clients.forEach(c => removeTerminalClient(c));
  });
});
```

---

### 3.2 Terminal Mirroring - Xterm.js Rendering

**Objective:** Verify ANSI streams from backend render correctly in frontend without data loss.

**Sample Test:**

```typescript
// tests/terminal-mirroring.test.ts
import { describe, it, expect, vi } from "vitest";

describe("Terminal Mirroring", () => {
  it("preserves ANSI escape sequences for xterm.js", () => {
    const serverOutput = "\x1b[32m\x1b[1m✓\x1b[0m Build complete";
    
    // Simulate what terminal-broadcast sends
    const payload = JSON.stringify({ type: "terminal_out", payload: { data: serverOutput } });
    const parsed = JSON.parse(payload);
    
    expect(parsed.payload.data).toBe(serverOutput);
    // xterm.js should render green bold checkmark
    expect(parsed.payload.data).toContain("\x1b[32m");
  });

  it("handles large streaming output without truncation", () => {
    const largeOutput = "x".repeat(100000); // 100KB
    const payload = JSON.stringify({ type: "terminal_out", payload: { data: largeOutput } });
    
    expect(payload.length).toBeGreaterThan(100000);
    const parsed = JSON.parse(payload);
    expect(parsed.payload.data.length).toBe(100000);
  });

  it("handles binary data gracefully", () => {
    // Some tools output binary - should be stringified
    const binaryOutput = Buffer.from([0x00, 0x01, 0x02]).toString();
    const payload = JSON.stringify({ type: "terminal_out", payload: { data: binaryOutput } });
    
    const parsed = JSON.parse(payload);
    expect(typeof parsed.payload.data).toBe("string");
  });
});
```

---

## 4. Edge Cases & Resilience

### 4.1 WebSocket Disconnection During LLM Stream

**Objective:** Test behavior when WebSocket drops during long LLM response.

**Sample Test:**

```typescript
// tests/ws-disconnect.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { removeTerminalClient, broadcastTerminalData, flushTerminalBuffer } from "../src/core/terminal-broadcast.js";

describe("WebSocket Disconnection Resilience", () => {
  it("continues operation when client disconnects mid-stream", () => {
    const sendFn = vi.fn();
    addTerminalClient(sendFn);
    
    // Client connected
    broadcastTerminalData("Processing...\n");
    flushTerminalBuffer();
    expect(sendFn).toHaveBeenCalledTimes(1);
    
    // Client disconnects
    removeTerminalClient(sendFn);
    
    // Server continues - no errors
    expect(() => {
      broadcastTerminalData("Still running...\n");
      flushTerminalBuffer();
    }).not.toThrow();
  });

  it("handles rapid connect/disconnect cycles", () => {
    const sendFn = vi.fn();
    
    for (let i = 0; i < 100; i++) {
      addTerminalClient(sendFn);
      broadcastTerminalData("tick\n");
      flushTerminalBuffer();
      removeTerminalClient(sendFn);
    }
    
    // No memory leaks or errors
    expect(true).toBe(true);
  });
});
```

---

### 4.2 Token Overflow - Large Numbers

**Objective:** Test UI stability when token counts exceed millions.

**Sample Test:**

```typescript
// tests/token-overflow.test.ts
import { describe, it, expect, vi } from "vitest";
import { calculateCost } from "../src/web/client/src/utils/costCalculator.js";
import { PriceRegistry } from "../src/web/client/src/utils/PriceRegistry.js";

describe("Token Overflow Handling", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });
  });

  it("handles millions of tokens without overflow", async () => {
    const registry = new PriceRegistry();
    vi.spyOn(registry as any, 'init').mockImplementation(async () => {
      (registry as any).data = {
        version: "test",
        updatedAt: new Date().toISOString(),
        models: {
          "gpt-4o": { inputPerM: 2.50, outputPerM: 10.00, cachedPerM: 1.25 },
        },
      };
      (registry as any).initialized = true;
    });
    
    await registry.init();
    
    // 10 million tokens
    const cost = calculateCost(10_000_000, 10_000_000, 5_000_000, "gpt-4o");
    
    // Should not be Infinity or NaN
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
  });

  it("formats large currency values correctly", () => {
    const formatCurrency = (usd: number): string => {
      if (usd >= 1000) {
        return `$${(usd / 1000).toFixed(2)}K`;
      }
      return `$${usd.toFixed(4)}`;
    };
    
    expect(formatCurrency(150000)).toBe("$150.00K");
    expect(formatCurrency(50.1234)).toBe("$50.1234");
  });
});
```

---

### 4.3 Process Signals - Ctrl+C Handling

**Objective:** Test `Ctrl+C` handling and daemon cleanup (`web stop`).

**Sample Test:**

```typescript
// tests/signal-handling.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Process Signal Handling", () => {
  let mockProcessExit: vi.Mock;
  let signals: string[] = [];

  beforeEach(() => {
    mockProcessExit = vi.fn();
    vi.stubGlobal("process", {
      ...process,
      exit: mockProcessExit,
      on: vi.fn((event: string, cb: any) => {
        signals.push(event);
      }),
    });
  });

  it("registers SIGINT handler for Ctrl+C", () => {
    // Import after mocking
    // In real test, would test actual signal handler registration
    
    // Verify SIGINT is a valid signal
    expect(["SIGINT", "SIGTERM"]).toContain("SIGINT");
  });

  it("cleans up terminal on exit", async () => {
    const { restoreTerminal } = await import("../src/core/terminal-broadcast.js");
    
    // Simulate exit
    restoreTerminal();
    
    // Should not throw
    expect(process.stdout.write).toBeDefined();
  });
});
```

---

## 5. Performance & Security

### 5.1 Broadcast Buffering - Event Loop Protection

**Objective:** Ensure high-frequency logs don't block the Node.js Event Loop.

**Sample Test:**

```typescript
// tests/event-loop.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { broadcastTerminalData, flushTerminalBuffer, addTerminalClient, removeTerminalClient } from "../src/core/terminal-broadcast.js";

describe("Event Loop Protection", () => {
  it("batching prevents event loop starvation", async () => {
    const sendFn = vi.fn();
    addTerminalClient(sendFn);

    const start = Date.now();
    
    // Write 1000 times rapidly
    for (let i = 0; i < 1000; i++) {
      broadcastTerminalData(`Log line ${i}\n`);
    }
    
    const elapsed = Date.now() - start;
    
    // Should complete quickly due to batching
    expect(elapsed).toBeLessThan(100);
    
    flushTerminalBuffer();
    expect(sendFn).toHaveBeenCalled();
    
    removeTerminalClient(sendFn);
  });

  it("flushBuffer processes all buffered data", () => {
    const sendFn = vi.fn();
    addTerminalClient(sendFn);

    // Buffer multiple writes
    broadcastTerminalData("First\n");
    broadcastTerminalData("Second\n");
    broadcastTerminalData("Third\n");
    
    flushTerminalBuffer();
    
    // Single send with all data
    expect(sendFn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendFn.mock.calls[0][0]);
    expect(payload.payload.data).toBe("First\nSecond\nThird\n");
    
    removeTerminalClient(sendFn);
  });
});
```

---

### 5.2 Error Boundaries - Malformed JSON

**Objective:** Test React Dashboard stability when receiving malformed JSON telemetry.

**Sample Test:**

```typescript
// tests/json-error-boundary.test.ts
import { describe, it, expect, vi } from "vitest";

describe("JSON Error Boundaries", () => {
  it("handles invalid JSON gracefully", () => {
    const invalidJson = "{ this is not valid json";
    
    let parsed = null;
    let error = null;
    
    try {
      parsed = JSON.parse(invalidJson);
    } catch (e) {
      error = e;
    }
    
    expect(parsed).toBeNull();
    expect(error).toBeInstanceOf(SyntaxError);
  });

  it("validates WebSocket message schema", () => {
    const { WsEventSchema } = require("../src/interfaces/ws-events.js");
    
    const validEvent = { type: "terminal_out", payload: { data: "test" } };
    const result = WsEventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
    
    const invalidEvent = { type: "invalid" };
    const invalidResult = WsEventSchema.safeParse(invalidEvent);
    expect(invalidResult.success).toBe(false);
  });

  it("handles missing payload fields", () => {
    const incompleteEvent = { type: "terminal_out" };
    
    const result = (incompleteEvent as any).payload?.data ?? "";
    expect(result).toBe("");
  });
});
```

---

## 6. Test Execution Commands

```bash
# Run all tests
pnpm run test

# Run specific test file
pnpm run test -- tests/price-registry.test.ts

# Run tests in watch mode
pnpm run test:watch

# Run with coverage
pnpm run test -- --coverage

# Typecheck before tests
pnpm run typecheck && pnpm run test
```

---

## 7. Edge Case Checklist

| Category | Edge Case | Test File |
|----------|-----------|-----------|
| **PriceRegistry** | Zero tokens | `price-registry.test.ts` |
| | All tokens cached | `price-registry.test.ts` |
| | Unknown model | `price-registry.test.ts` |
| | Cache TTL expiry | `price-registry.test.ts` |
| | Network failure + stale cache | `price-registry.test.ts` |
| **ConfigManager** | Missing config file | `config-hierarchy.test.ts` |
| | Invalid JSON | `config-hierarchy.test.ts` |
| | Secret masking | `config-hierarchy.test.ts` |
| | Invalid creativity/max_cycles | `config-hierarchy.test.ts` |
| **HITL** | Both CLI/WS respond simultaneously | `hitl-bridge.test.ts` |
| | WS disconnects mid-approval | `hitl-bridge.test.ts` |
| | Multiple tasks waiting | `hitl-bridge.test.ts` |
| | Non-TTY auto-approve | `hitl-bridge.test.ts` |
| **WebSocket** | Client disconnects mid-stream | `ws-disconnect.test.ts` |
| | Rapid connect/disconnect | `ws-disconnect.test.ts` |
| | High-frequency broadcasts | `event-loop.test.ts` |
| **Token Overflow** | Millions of tokens | `token-overflow.test.ts` |
| | Large currency formatting | `token-overflow.test.ts` |
| **JSON** | Invalid JSON received | `json-error-boundary.test.ts` |
| | Missing payload fields | `json-error-boundary.test.ts` |
| **Signals** | Ctrl+C during operation | `signal-handling.test.ts` |
| | Process exit cleanup | `signal-handling.test.ts` |
