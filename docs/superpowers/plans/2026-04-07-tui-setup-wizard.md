# TUI Setup Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the setup flow into the TUI as a native `InteractiveView` wizard, replacing the `@clack/prompts` first-run gate.

**Architecture:** `SetupWizardView extends InteractiveView` — a 5-step wizard using the same pattern as `SettingsView`. Auto-triggered when no provider is configured. Also available via `/setup` command.

**Tech Stack:** Custom TUI framework (retained-mode, `string[]` rendering), TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-07-tui-setup-wizard-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/app/interactive/setup-wizard-view.ts` | Multi-step setup wizard view |
| Create | `src/app/commands/setup.ts` | `/setup` slash command |
| Create | `tests/app/interactive/setup-wizard-view.test.ts` | Wizard state machine and rendering tests |
| Modify | `src/app/index.ts` | Auto-trigger wizard when no provider configured |
| Modify | `src/app/commands/index.ts` | Register `/setup` command |
| Modify | `src/cli.ts` | Remove `runSetup()` from first-run block (TUI handles it) |

---

## Task 1: Create `SetupWizardView` — Core State Machine

**Files:**
- Create: `src/app/interactive/setup-wizard-view.ts`
- Create: `tests/app/interactive/setup-wizard-view.test.ts`
- Reference: `src/app/interactive/base-view.ts` (InteractiveView base)
- Reference: `src/app/interactive/settings-view.ts` (field editing patterns)
- Reference: `src/providers/detect.ts` (detectProviders)
- Reference: `src/providers/validate.ts` (validateApiKey)
- Reference: `src/providers/model-fetcher.ts` (fetchModelsForProvider)
- Reference: `src/providers/model-cache.ts` (getCachedModels, setCachedModels)
- Reference: `src/providers/provider-catalog.ts` (PROVIDER_CATALOG, getProviderMeta)
- Reference: `src/credentials/credential-store.ts` (CredentialStore)
- Reference: `src/credentials/masking.ts` (maskCredential)
- Reference: `src/core/global-config.ts` (writeGlobalConfig, readGlobalConfig, OpenPawlGlobalConfig, ProviderConfigEntry)
- Reference: `src/tui/components/panel.ts` (renderPanel)

- [ ] **Step 1: Write test scaffolding**

```typescript
// tests/app/interactive/setup-wizard-view.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("../../../src/providers/detect.js", () => ({
  detectProviders: vi.fn(),
}));
vi.mock("../../../src/providers/validate.js", () => ({
  validateApiKey: vi.fn(),
}));
vi.mock("../../../src/providers/model-fetcher.js", () => ({
  fetchModelsForProvider: vi.fn(),
}));
vi.mock("../../../src/providers/model-cache.js", () => ({
  getCachedModels: vi.fn(() => Promise.resolve(null)),
  setCachedModels: vi.fn(),
}));
vi.mock("../../../src/credentials/credential-store.js", () => ({
  CredentialStore: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({ isOk: () => true }),
    setCredential: vi.fn().mockResolvedValue({ isOk: () => true }),
  })),
}));
vi.mock("../../../src/core/global-config.js", () => ({
  writeGlobalConfig: vi.fn(() => "~/.openpawl/config.json"),
  readGlobalConfig: vi.fn(() => null),
}));
vi.mock("../../../src/providers/provider-catalog.js", () => ({
  PROVIDER_CATALOG: {
    anthropic: { name: "Anthropic", authMethod: "apikey", envKeys: ["ANTHROPIC_API_KEY"], models: [{ id: "claude-sonnet-4-6" }], menuLabel: "Anthropic", openaiCompatible: false },
    openai: { name: "OpenAI", authMethod: "apikey", envKeys: ["OPENAI_API_KEY"], models: [{ id: "gpt-4o" }], menuLabel: "OpenAI", openaiCompatible: true },
    ollama: { name: "Ollama", authMethod: "local", envKeys: [], models: [], menuLabel: "Ollama (local)", openaiCompatible: false, baseURL: "http://localhost:11434" },
  },
  getProviderMeta: vi.fn((id: string) => {
    const catalog: Record<string, any> = {
      anthropic: { name: "Anthropic", authMethod: "apikey", envKeys: ["ANTHROPIC_API_KEY"], models: [{ id: "claude-sonnet-4-6" }], menuLabel: "Anthropic", openaiCompatible: false, baseURL: "https://api.anthropic.com" },
      openai: { name: "OpenAI", authMethod: "apikey", envKeys: ["OPENAI_API_KEY"], models: [{ id: "gpt-4o" }], menuLabel: "OpenAI", openaiCompatible: true, baseURL: "https://api.openai.com/v1" },
      ollama: { name: "Ollama", authMethod: "local", envKeys: [], models: [], menuLabel: "Ollama (local)", openaiCompatible: false, baseURL: "http://localhost:11434" },
    };
    return catalog[id] ?? null;
  }),
}));

import { detectProviders } from "../../../src/providers/detect.js";
import { validateApiKey } from "../../../src/providers/validate.js";
import { fetchModelsForProvider } from "../../../src/providers/model-fetcher.js";
import { writeGlobalConfig } from "../../../src/core/global-config.js";
import { ok } from "neverthrow";

// Minimal TUI mock
function createMockTUI() {
  return {
    pushKeyHandler: vi.fn(),
    popKeyHandler: vi.fn(),
    setInteractiveView: vi.fn(),
    clearInteractiveView: vi.fn(),
    setClickHandler: vi.fn(),
    getInteractiveStartRow: vi.fn(() => 10),
    requestRender: vi.fn(),
    getTerminal: vi.fn(() => ({ columns: 80, rows: 24 })),
  };
}

describe("SetupWizardView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts in DETECT step and auto-advances to PROVIDER", async () => {
    vi.mocked(detectProviders).mockResolvedValue([
      { type: "anthropic", available: true, source: "env", envKey: "ANTHROPIC_API_KEY" },
      { type: "ollama", available: false, source: "ollama" },
    ]);

    const tui = createMockTUI();
    const onClose = vi.fn();
    const { SetupWizardView } = await import("../../../src/app/interactive/setup-wizard-view.js");
    const view = new SetupWizardView(tui as any, onClose);
    view.activate();

    // Should have called detectProviders
    expect(detectProviders).toHaveBeenCalled();

    // Wait for async detection to complete
    await vi.waitFor(() => {
      // After detection, should re-render with PROVIDER step
      expect(tui.setInteractiveView).toHaveBeenCalled();
      const lastCall = tui.setInteractiveView.mock.calls.at(-1)?.[0] as string[];
      const joined = lastCall?.join("\n") ?? "";
      expect(joined).toContain("Select a provider");
    });
  });

  it("skips API_KEY step for local providers", async () => {
    vi.mocked(detectProviders).mockResolvedValue([
      { type: "ollama", available: true, source: "ollama", models: ["llama3"] },
    ]);
    vi.mocked(fetchModelsForProvider).mockResolvedValue({
      models: [{ id: "llama3", name: "llama3" }],
      source: "api",
    } as any);

    const tui = createMockTUI();
    const { SetupWizardView } = await import("../../../src/app/interactive/setup-wizard-view.js");
    const view = new SetupWizardView(tui as any, vi.fn());
    view.activate();

    await vi.waitFor(() => {
      const lastCall = tui.setInteractiveView.mock.calls.at(-1)?.[0] as string[];
      expect(lastCall?.join("\n")).toContain("Select a provider");
    });

    // Select ollama (Enter on first item which is ollama)
    view.handleKey({ type: "enter" } as any);

    // Should skip API_KEY and go to MODEL step
    await vi.waitFor(() => {
      const lastCall = tui.setInteractiveView.mock.calls.at(-1)?.[0] as string[];
      expect(lastCall?.join("\n")).toContain("Select a model");
    });
  });

  it("saves config on confirm step", async () => {
    vi.mocked(detectProviders).mockResolvedValue([
      { type: "anthropic", available: true, source: "env", envKey: "ANTHROPIC_API_KEY" },
    ]);
    vi.mocked(validateApiKey).mockResolvedValue(ok({ latencyMs: 200 }));
    vi.mocked(fetchModelsForProvider).mockResolvedValue({
      models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
      source: "api",
    } as any);

    const tui = createMockTUI();
    const onClose = vi.fn();
    const { SetupWizardView } = await import("../../../src/app/interactive/setup-wizard-view.js");
    const view = new SetupWizardView(tui as any, onClose);

    // Set env var for auto-fill
    const origEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

    view.activate();

    // Wait for PROVIDER step
    await vi.waitFor(() => {
      const lastCall = tui.setInteractiveView.mock.calls.at(-1)?.[0] as string[];
      expect(lastCall?.join("\n")).toContain("Select a provider");
    });

    // Select anthropic
    view.handleKey({ type: "enter" } as any);

    // API_KEY step — should auto-fill from env, press Enter to confirm
    await vi.waitFor(() => {
      const lastCall = tui.setInteractiveView.mock.calls.at(-1)?.[0] as string[];
      expect(lastCall?.join("\n")).toContain("API key");
    });
    view.handleKey({ type: "enter" } as any);

    // Wait for validation + MODEL step
    await vi.waitFor(() => {
      const lastCall = tui.setInteractiveView.mock.calls.at(-1)?.[0] as string[];
      expect(lastCall?.join("\n")).toContain("Select a model");
    });

    // Select model
    view.handleKey({ type: "enter" } as any);

    // CONFIRM step — press Enter to save
    await vi.waitFor(() => {
      const lastCall = tui.setInteractiveView.mock.calls.at(-1)?.[0] as string[];
      expect(lastCall?.join("\n")).toContain("Configuration");
    });
    view.handleKey({ type: "enter" } as any);

    // Should have written config
    await vi.waitFor(() => {
      expect(writeGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProvider: "anthropic",
          activeModel: "claude-sonnet-4-6",
        }),
      );
    });

    process.env.ANTHROPIC_API_KEY = origEnv;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/app/interactive/setup-wizard-view.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `SetupWizardView`**

Create `src/app/interactive/setup-wizard-view.ts`. The implementation must:

1. **Extend `InteractiveView`** — use `renderLines()`, `handleCustomKey()`, `getItemCount()`, `getPanelTitle()`, `getPanelFooter()` pattern
2. **5-step state machine** — enum `WizardStep { DETECT, PROVIDER, API_KEY, MODEL, CONFIRM }`
3. **Per-step rendering** — each step returns `string[]` lines from its own render method
4. **Per-step key handling** — each step has its own key handler
5. **Async operations** — detection, validation, model fetching all run async and call `this.render()` when done
6. **Provider grouping** — detected first with ✓, popular tier, "Show all..." toggle

Key implementation details:

- `constructor(tui: TUI, onClose: () => void, prefill?: OpenPawlGlobalConfig)` — optional prefill for re-setup
- `override activate()` — calls `super.activate()` then starts detection
- Step transitions: `nextStep()` and `prevStep()` methods
- For DETECT step: call `detectProviders()`, store results, auto-advance when done
- For PROVIDER step: build grouped options list, Up/Down navigate, Enter selects
- For API_KEY step: check env var auto-fill, password input with cursor, Enter validates
- For MODEL step: async fetch with loading state, Up/Down navigate, Enter selects  
- For CONFIRM step: summary rendering, health check, Enter saves + closes
- Navigation: Enter/Tab = next, Shift+Tab/Backspace (not editing) = back, Esc = back (or close on step 1)

Follow the field editing patterns from `SettingsView`:
- Password: `editBuffer` tracked raw, displayed as `•` bullets with `█` cursor
- Select: `selectIndex` tracks position, `▸` marker on selected item
- Loading: set status text, call `this.render()`, then async operation, then re-render

Provider grouping in PROVIDER step:
```
  ✓ Anthropic (ANTHROPIC_API_KEY found)
  ✓ Ollama (3 models)
  ─────────────────────────────
    OpenAI
  ─────────────────────────────
  ▸ Show all providers...
```

The items list is a flat array where separators and the "expand" item have special handling:
- `{ type: "provider", id: "anthropic", label: "Anthropic", hint: "detected" }`
- `{ type: "separator" }`
- `{ type: "expand", label: "Show all providers..." }`

Only `provider` items are selectable. Up/Down skip separators. Enter on `expand` toggles the full list.

Config save on CONFIRM:
```typescript
const entry: ProviderConfigEntry = {
  type: this.selectedProvider as any,
  hasCredential: this.needsKey,
  model: this.selectedModel,
};
const config: OpenPawlGlobalConfig = {
  ...(this.prefill ?? { version: 1 }),
  activeProvider: this.selectedProvider,
  activeModel: this.selectedModel,
  model: this.selectedModel,
  providers: [entry, ...existingOtherProviders],
};
writeGlobalConfig(config);
```

The `onClose` callback is called after save — the caller uses it to re-detect config and update status bar.

- [ ] **Step 4: Run tests**

Run: `bun run test -- tests/app/interactive/setup-wizard-view.test.ts`
Expected: all 3 tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/interactive/setup-wizard-view.ts tests/app/interactive/setup-wizard-view.test.ts
git commit -m "feat: add SetupWizardView — TUI-native setup wizard"
```

---

## Task 2: Create `/setup` Command + Register

**Files:**
- Create: `src/app/commands/setup.ts`
- Modify: `src/app/commands/index.ts`

- [ ] **Step 1: Create `/setup` command**

```typescript
// src/app/commands/setup.ts
import type { SlashCommand } from "../../tui/index.js";
import { SetupWizardView } from "../interactive/setup-wizard-view.js";

export function createSetupCommand(): SlashCommand {
  return {
    name: "setup",
    description: "Run setup wizard",
    async execute(_args, ctx) {
      if (!ctx.tui) {
        ctx.addMessage("error", "Setup wizard requires TUI. Run: openpawl setup");
        return;
      }
      let prefill;
      try {
        const { readGlobalConfig } = await import("../../core/global-config.js");
        prefill = readGlobalConfig() ?? undefined;
      } catch { /* first run — no config */ }
      const wizard = new SetupWizardView(ctx.tui, () => { /* closed */ }, prefill);
      wizard.activate();
    },
  };
}
```

- [ ] **Step 2: Register in command index**

In `src/app/commands/index.ts`, add import and registration alongside the other commands:

```typescript
import { createSetupCommand } from "./setup.js";
// In the registration function:
registry.register(createSetupCommand());
```

Find the pattern — look for `createSettingsCommand()` or `createModelCommand()` registration and follow the same pattern.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/commands/setup.ts src/app/commands/index.ts
git commit -m "feat: add /setup slash command for TUI setup wizard"
```

---

## Task 3: Auto-trigger Wizard + Update CLI Entry Point

**Files:**
- Modify: `src/app/index.ts` (~lines 550-566)
- Modify: `src/cli.ts` (~lines 136-162)

- [ ] **Step 1: Auto-trigger wizard in `launchTUI()`**

In `src/app/index.ts`, find the block after `detectConfig()` (around lines 550-566). Currently:

```typescript
const configState = await detectConfig();
if (configState.hasProvider) {
  layout.statusBar.updateSegment(0, configState.providerName, ctp.subtext1);
  // ... more status bar updates
}
showConfigWarning(configState, layout);
```

Change the `showConfigWarning` call to:

```typescript
if (!configState.hasProvider) {
  // Auto-trigger setup wizard instead of text warning
  const { SetupWizardView } = await import("./interactive/setup-wizard-view.js");
  const wizard = new SetupWizardView(layout.tui, async () => {
    // On wizard close: re-detect config, update status bar, init router
    const newState = await detectConfig();
    if (newState.hasProvider) {
      layout.statusBar.updateSegment(0, newState.providerName, ctp.subtext1);
      if (newState.isConnected) {
        // Re-initialize session router now that we have a provider
        await initSessionRouter();
      }
    }
  });
  wizard.activate();
} else if (configState.error) {
  showConfigWarning(configState, layout);
}
```

Keep `showConfigWarning` for the error-only case (provider exists but connection failed).

- [ ] **Step 2: Update CLI first-run block**

In `src/cli.ts`, find the first-run detection block (where it checks `!existsSync(configPath)` and calls `runSetup()`). Change it so the TUI handles first-run:

```typescript
// Remove the runSetup() call from first-run block
// The TUI will auto-trigger the wizard when no config exists
if (!existsSync(configPath)) {
  // No config — TUI will show setup wizard automatically
  // Just launch TUI directly
}

const { launchTUI } = await import("./app/index.js");
await launchTUI();
return;
```

Keep the `openpawl setup` CLI command path (which calls `runSetup()` from `setup-flow.ts`) for non-TUI use.

- [ ] **Step 3: Run typecheck + full tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

```bash
# Backup config
mv ~/.openpawl/config.json ~/.openpawl/config.json.bak

# Test first-run: should show wizard inside TUI
openpawl

# Test /setup: should show wizard with pre-filled values
# (after restoring config)
mv ~/.openpawl/config.json.bak ~/.openpawl/config.json
openpawl
# Type: /setup
```

- [ ] **Step 5: Commit**

```bash
git add src/app/index.ts src/cli.ts
git commit -m "feat: auto-trigger setup wizard in TUI on first run"
```
