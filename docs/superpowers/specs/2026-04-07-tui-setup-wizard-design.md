# TUI Setup Wizard — Design Spec

**Date:** 2026-04-07
**Approach:** Setup as a TUI InteractiveView (Option A)

## Problem

The setup flow (`src/onboard/setup-flow.ts`) uses `@clack/prompts` — a separate CLI toolkit that takes over stdin. When user runs `openpawl` for the first time:

1. CLI detects no config → runs `@clack/prompts` wizard (completely different look/feel)
2. After wizard completes → launches TUI

This creates a jarring UX disconnect. Setup should be part of the TUI itself.

## Goals

1. First-run setup happens inside the TUI as a wizard screen
2. `/setup` command re-runs the same wizard with pre-filled values
3. Provider list is grouped (detected → top tier → expand all)
4. The `@clack/prompts` path stays for non-TUI use (`openpawl setup` CLI)

## Architecture

### How InteractiveView works (existing pattern)

`InteractiveView` is the base class for all modal TUI panels:
- `activate()` → pushes key handler, renders lines at bottom of scrollable area
- `handleKey()` → Up/Down navigate, Escape closes, delegates to `handleCustomKey()`
- `renderLines()` → returns `string[]` with ANSI codes, wrapped in a `renderPanel()` border
- `deactivate()` → pops key handler, clears view

Three views exist: `SettingsView`, `ModeView`, `ModelView`. All follow this pattern.

### SetupWizardView design

`SetupWizardView extends InteractiveView` — a multi-step wizard.

**State machine:**

```
DETECT → PROVIDER → API_KEY → MODEL → CONFIRM → done
                      ↓ (local provider)
                    MODEL (skip API_KEY)
```

Each step has:
- A render function returning `string[]`
- A key handler for that step's interaction (select list, text input, etc.)
- A transition function that advances to the next step

**Panel title:** `"Setup (2/5) — Select Provider"` — changes per step.
**Panel footer:** `"↑↓ navigate · Enter select · Esc back"` — changes per step.

### Steps

**Step 1: Detect** (auto, no user input)
- Calls `detectProviders()` from `src/providers/detect.ts`
- Renders detection results with ✓/· indicators
- Auto-advances to Step 2 after detection completes (~1-3s)

**Step 2: Provider Select**
- Grouped list:
  1. **Detected** — providers found via env vars or local probes (with ✓)
  2. **Popular** — Anthropic, OpenAI, Ollama (if not already in detected)
  3. **More providers...** — expand item that shows remaining 20+ providers
- Up/Down navigate, Enter selects
- Selected provider determines if Step 3 is needed (local providers skip)

**Step 3: API Key** (skipped for local providers)
- Password input (bullets `•`, cursor `█`)
- If env var detected for this provider, show "Using ANTHROPIC_API_KEY from environment" and auto-fill
- On Enter: validate via `validateApiKey()` from `src/providers/validate.ts`
- Show inline error on failure, re-prompt
- On success: store via `CredentialStore.setCredential()`

**Step 4: Model Select**
- Async-load models via `fetchModelsForProvider()` + cache
- Show loading indicator while fetching
- Up/Down navigate, Enter selects
- Falls back to catalog models if fetch fails

**Step 5: Confirm**
- Summary box showing provider, model, config path
- Connection health check with latency display
- Enter = save and close, Esc = go back

### Navigation

- **Enter** / **Tab** = advance to next step (or select current item)
- **Shift+Tab** / **Backspace** (when not editing) = go back one step
- **Escape** = back one step (on Step 1: close wizard with confirm if first-run)

### Config persistence

On confirm (Step 5):
- `writeGlobalConfig()` with `activeProvider`, `activeModel`, `hasCredential`
- `CredentialStore.setCredential()` for API key (already done in Step 3)
- Trigger `initSessionRouter()` re-initialization
- Close wizard, show "Connected to Anthropic" in status bar

### Auto-trigger

In `src/app/index.ts:550-566`, after `detectConfig()`:

```typescript
if (!configState.hasProvider) {
  // Instead of showConfigWarning(), activate the wizard
  const wizard = new SetupWizardView(layout.tui, () => {
    // On close: re-detect config, update status bar, init router
  });
  wizard.activate();
}
```

### `/setup` command

New slash command (`src/app/commands/setup.ts`):

```typescript
export function createSetupCommand(): SlashCommand {
  return {
    name: "setup",
    description: "Run setup wizard",
    async execute(_args, ctx) {
      if (!ctx.tui) { ctx.addMessage("error", "Use openpawl setup in CLI"); return; }
      const existing = readGlobalConfig();
      const wizard = new SetupWizardView(ctx.tui, () => {}, existing);
      wizard.activate();
    },
  };
}
```

## Provider Grouping Detail

The full provider list (22+ items) is too long. Three tiers:

```
  ✓ Anthropic (ANTHROPIC_API_KEY found)    ← detected
  ✓ Ollama (3 models)                      ← detected
  ──────────────────────────────
    OpenAI                                  ← popular (not detected)
  ──────────────────────────────
  ▸ Show all providers...                   ← expands to full list
```

When "Show all providers..." is selected, the list expands inline (no sub-menu):

```
  ✓ Anthropic (detected)
  ✓ Ollama (3 models)
  ──────────────────────────────
    OpenAI
    OpenRouter
    DeepSeek
    Groq
    Gemini
    ... (all 22+ providers)
```

The expand is a toggle — pressing Enter on the item shows/hides the full list.

## New Files

| File | LOC est. | Purpose |
|------|----------|---------|
| `src/app/interactive/setup-wizard-view.ts` | ~350 | `SetupWizardView extends InteractiveView` |
| `src/app/commands/setup.ts` | ~25 | `/setup` slash command |
| `tests/app/interactive/setup-wizard-view.test.ts` | ~150 | State machine and rendering tests |

## Modified Files

| File | Change |
|------|--------|
| `src/app/index.ts:550-566` | Replace `showConfigWarning()` with `SetupWizardView.activate()` when no provider |
| `src/app/commands/index.ts` | Register `/setup` command |
| `src/app/config-check.ts` | Keep `detectConfig()`, `showConfigWarning()` still used for error-only cases |
| `src/cli.ts` | Remove inline `runSetup()` call from first-run block — TUI handles it |

## What's Reused (no changes)

- `src/providers/detect.ts` — `detectProviders()`
- `src/providers/validate.ts` — `validateApiKey()`
- `src/providers/model-fetcher.ts` + `model-cache.ts`
- `src/providers/provider-catalog.ts` — `PROVIDER_CATALOG`, `getProviderMeta()`
- `src/credentials/credential-store.ts` — `setCredential()`
- `src/credentials/masking.ts` — `maskCredential()`
- `src/core/global-config.ts` — `writeGlobalConfig()`, `readGlobalConfig()`
- `src/app/interactive/base-view.ts` — `InteractiveView` base class
- `src/tui/components/panel.ts` — `renderPanel()`
- `src/onboard/setup-flow.ts` — kept for CLI-only path (`openpawl setup` outside TUI)

## Testing

- Unit test the state machine: step transitions, back navigation, skip API key for local providers
- Unit test rendering: each step produces correct `string[]` output
- Unit test provider grouping: detected sorted first, expand toggle works
- Integration: mock all external calls (detect, validate, fetch models, credential store, config write)
