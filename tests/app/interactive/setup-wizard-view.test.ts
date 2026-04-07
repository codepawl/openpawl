/**
 * Tests for SetupWizardView — TUI-native setup wizard.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mock all external dependencies before import ────────────

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
  getCachedModels: vi.fn().mockResolvedValue(null),
  setCachedModels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/credentials/credential-store.js", () => ({
  CredentialStore: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({ isOk: () => true }),
    setCredential: vi.fn().mockResolvedValue({ isOk: () => true }),
  })),
}));

vi.mock("../../../src/core/global-config.js", () => ({
  readGlobalConfig: vi.fn().mockReturnValue(null),
  writeGlobalConfig: vi.fn().mockReturnValue("/home/test/.openpawl/config.json"),
}));

vi.mock("../../../src/providers/provider-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/providers/provider-catalog.js")>(
    "../../../src/providers/provider-catalog.js",
  );
  return actual;
});

vi.mock("../../../src/credentials/masking.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/credentials/masking.js")>(
    "../../../src/credentials/masking.js",
  );
  return actual;
});

import { SetupWizardView } from "../../../src/app/interactive/setup-wizard-view.js";
import { detectProviders } from "../../../src/providers/detect.js";
import { validateApiKey } from "../../../src/providers/validate.js";
import { fetchModelsForProvider } from "../../../src/providers/model-fetcher.js";
import { writeGlobalConfig } from "../../../src/core/global-config.js";
import type { DetectedProvider } from "../../../src/providers/detect.js";
import type { TUI } from "../../../src/tui/core/tui.js";

// ── Minimal TUI mock ────────────────────────────────────────

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
  } as unknown as TUI;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

describe("SetupWizardView", () => {
  let tui: TUI;
  let onClose: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    tui = createMockTUI();
    onClose = vi.fn();
  });

  it("starts in DETECT step and auto-advances to PROVIDER", async () => {
    const detected: DetectedProvider[] = [
      { type: "anthropic", available: true, source: "env", envKey: "ANTHROPIC_API_KEY" },
      { type: "ollama", available: false, source: "ollama" },
    ];
    (detectProviders as Mock).mockResolvedValue(detected);

    const wizard = new SetupWizardView(tui, onClose);
    wizard.activate();

    // First render should show detecting state
    expect((tui.setInteractiveView as Mock).mock.calls.length).toBeGreaterThanOrEqual(1);

    // Wait for detection to complete
    await flush();

    // After detection, should show results with Anthropic detected
    let lastCall = (tui.setInteractiveView as Mock).mock.calls.at(-1)?.[0] as string[];
    let joined = lastCall.join("\n");
    expect(joined).toContain("anthropic");

    // Press Enter to advance to PROVIDER step
    wizard.handleKey({ type: "enter" });

    lastCall = (tui.setInteractiveView as Mock).mock.calls.at(-1)?.[0] as string[];
    joined = lastCall.join("\n");
    // Should show Anthropic in provider list
    expect(joined).toContain("Anthropic");
  });

  it("skips API_KEY step for local providers", async () => {
    const detected: DetectedProvider[] = [
      { type: "ollama", available: true, source: "ollama", models: ["llama3"] },
    ];
    (detectProviders as Mock).mockResolvedValue(detected);
    (fetchModelsForProvider as Mock).mockResolvedValue({
      models: [{ id: "llama3", name: "llama3", isChatModel: true }],
      source: "live",
    });

    const wizard = new SetupWizardView(tui, onClose);
    wizard.activate();
    await flush();

    // Advance past DETECT step
    wizard.handleKey({ type: "enter" });

    // Should be on PROVIDER step with ollama visible
    let lastCall = (tui.setInteractiveView as Mock).mock.calls.at(-1)?.[0] as string[];
    let joined = lastCall.join("\n");
    expect(joined).toContain("Ollama");

    // Select ollama (first item, already selected) — press Enter
    wizard.handleKey({ type: "enter" });
    await flush();

    // Should jump to MODEL step (skipping API_KEY) and show model list
    lastCall = (tui.setInteractiveView as Mock).mock.calls.at(-1)?.[0] as string[];
    joined = lastCall.join("\n");
    // Title should say Model
    expect(joined).toContain("Model");
  });

  it("saves config on confirm step", async () => {
    const detected: DetectedProvider[] = [
      { type: "anthropic", available: true, source: "env", envKey: "ANTHROPIC_API_KEY" },
    ];
    (detectProviders as Mock).mockResolvedValue(detected);
    (validateApiKey as Mock).mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: { latencyMs: 150 },
      error: undefined,
    });
    (fetchModelsForProvider as Mock).mockResolvedValue({
      models: [
        { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", isChatModel: true },
        { id: "claude-opus-4-6", name: "claude-opus-4-6", isChatModel: true },
      ],
      source: "live",
    });

    // Set env var for auto-fill
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-1234567890";

    try {
      const wizard = new SetupWizardView(tui, onClose);
      wizard.activate();
      await flush();

      // Advance past DETECT step
      wizard.handleKey({ type: "enter" });

      // PROVIDER step — select Anthropic (first detected item)
      wizard.handleKey({ type: "enter" });
      await flush();

      // API_KEY step — env key auto-filled, press Enter to validate
      wizard.handleKey({ type: "enter" });
      await flush();

      // MODEL step — select first model
      wizard.handleKey({ type: "enter" });
      await flush();

      // CONFIRM step — press Enter to save
      wizard.handleKey({ type: "enter" });

      // Verify writeGlobalConfig was called with correct data
      expect(writeGlobalConfig).toHaveBeenCalledTimes(1);
      const savedConfig = (writeGlobalConfig as Mock).mock.calls[0]![0];
      expect(savedConfig.activeProvider).toBe("anthropic");
      expect(savedConfig.activeModel).toBe("claude-sonnet-4-6");
      expect(savedConfig.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "anthropic",
            hasCredential: true,
            model: "claude-sonnet-4-6",
          }),
        ]),
      );

      // Wizard should have deactivated
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      if (origKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });
});
