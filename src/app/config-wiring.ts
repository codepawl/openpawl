/**
 * Provider config wiring — tier 1 instant check, connection state, provider registry, setup wizard.
 */

import { mark } from "./startup.js";
import { initSessionRouter, type AppContext } from "./init-session-router.js";
import { checkConfigInstant, detectConfig, pingProvider, showConfigWarning } from "./config-check.js";
import { setConnectionState, getConnectionState, onConnectionChange, getStatusDisplay, type ConnectionStatus } from "../core/connection-state.js";
import { DOT_SYMBOL } from "../tui/components/status-indicator.js";
import { ICONS } from "../tui/constants/icons.js";
import { defaultTheme } from "../tui/themes/default.js";
import type { AppLayout } from "./layout.js";
import type { LaunchOptions } from "./index.js";
import type { CommandRegistry } from "../tui/index.js";

export interface ConfigWiringResult {
  instantConfig: ReturnType<typeof checkConfigInstant>;
  initialHealthCheckDone: boolean;
  refreshProviderConfig: () => void;
  getProviderActiveModel: () => string | null;
}

export async function setupConfigAndProviders(
  layout: AppLayout,
  ctx: AppContext,
  opts: LaunchOptions | undefined,
  registry: CommandRegistry,
  addWelcomeMessage: () => void,
): Promise<ConfigWiringResult> {
  // ── Status bar segments ──────────────────────────────────────────
  layout.statusBar.setSegments([
    { text: "no provider", color: defaultTheme.secondary },
    { text: `${DOT_SYMBOL.empty} not configured`, color: defaultTheme.error },
    { text: `${ICONS.modeSolo} solo`, color: defaultTheme.dim },
    { text: "idle", color: defaultTheme.dim },
    { text: "", color: defaultTheme.dim },
  ]);
  layout.statusBar.setRightText(defaultTheme.dim("/help"));

  // ── Workspace config overlay ──────────────────────────────────────
  mark("workspace detection start");
  {
    const { isWorkspaceInitialized, readWorkspaceConfig, getWorkspaceInfo } = await import("../core/workspace.js");
    if (isWorkspaceInitialized()) {
      const wsConfig = readWorkspaceConfig();
      if (wsConfig) {
        const { setWorkspaceOverlay } = await import("../core/global-config.js");
        setWorkspaceOverlay(wsConfig as Record<string, unknown>);
      }
      const info = getWorkspaceInfo();
      layout.statusBar.setRightText(defaultTheme.dim(`\ud83d\udcc1 ${info.projectName}  /help`));
    }
  }
  mark("workspace detection done");

  // ── Tier 1: Instant config check ──────────────────────────────────
  mark("tier1 config check start");
  const instantConfig = checkConfigInstant();
  const { initProviderConfig, refreshProviderConfig, getActiveModel: getProviderActiveModel } = await import("../core/provider-config.js");
  initProviderConfig();
  mark("tier1 config check done");

  if (instantConfig.hasProvider && instantConfig.hasKey) {
    setConnectionState({ status: "ready", providerName: instantConfig.providerName });
  } else if (instantConfig.hasProvider && !instantConfig.hasKey) {
    setConnectionState({ status: "no_key", providerName: instantConfig.providerName });
  } else {
    setConnectionState({ status: "no_key", providerName: "" });
  }

  // Wire connection state → status bar
  const colorMap = {
    green: defaultTheme.success,
    red: defaultTheme.error,
    yellow: defaultTheme.warning,
    blue: defaultTheme.info,
    dim: defaultTheme.dim,
  };
  const updateStatusFromConnection = (state: { status: ConnectionStatus; providerName: string }) => {
    const display = getStatusDisplay(state.status);
    if (state.providerName) {
      const model = getProviderActiveModel();
      const modelShort = model && model.length > 20 ? model.slice(0, 18) + "\u2026" : model;
      const providerDisplay = model
        ? `${state.providerName} ${ICONS.diamond} ${modelShort}`
        : state.providerName;
      layout.statusBar.updateSegment(0, providerDisplay, defaultTheme.secondary);
    }
    layout.statusBar.updateSegment(1, display.text, colorMap[display.colorKey]);
    layout.tui.requestRender();
  };
  onConnectionChange(updateStatusFromConnection);
  updateStatusFromConnection(getConnectionState());

  // Sync status bar when provider/model changes in settings
  {
    const { onProviderConfigChange } = await import("../core/provider-config.js");
    const { resetGlobalProviderManager } = await import("../providers/provider-factory.js");
    onProviderConfigChange((event) => {
      resetGlobalProviderManager();
      const modelShort = event.model.length > 20 ? event.model.slice(0, 18) + "\u2026" : event.model;
      const providerDisplay = event.model
        ? `${event.provider} ${ICONS.diamond} ${modelShort}`
        : event.provider || "no provider";
      layout.statusBar.updateSegment(0, providerDisplay, defaultTheme.secondary);
      layout.tui.requestRender();
    });
  }

  ctx.configState = {
    hasProvider: instantConfig.hasProvider,
    providerName: instantConfig.providerName,
    isConnected: false,
    error: instantConfig.hasProvider && !instantConfig.hasKey ? "No API key" : null,
  };

  // ── Provider registry: background refresh + status bar sync ──────
  let initialHealthCheckDone = false;
  {
    const { getProviderRegistry } = await import("../providers/provider-registry.js");
    const providerRegistry = getProviderRegistry();
    providerRegistry.refreshAll().catch(() => {});

    providerRegistry.on("models:refreshed", async () => {
      if (!initialHealthCheckDone) return;
      const current = getConnectionState();
      if (current.status === "connected") return;
      try {
        const { resetGlobalProviderManager } = await import("../providers/provider-factory.js");
        resetGlobalProviderManager();
        const { status, error } = await pingProvider(5000);
        const providerName = current.providerName || instantConfig.providerName;
        setConnectionState({ status, providerName });
        ctx.configState = {
          hasProvider: true,
          providerName,
          isConnected: status === "connected",
          error: error ?? null,
        };
      } catch { /* swallow */ }
    });
  }

  if (!instantConfig.hasProvider) {
    layout.editor.hidden = true;
    layout.divider.hidden = true;
    layout.messages.hidden = true;

    const { SetupWizardView } = await import("./interactive/setup-wizard-view.js");
    const wizard = new SetupWizardView(layout.tui, async () => {
      layout.editor.hidden = false;
      layout.divider.hidden = false;
      layout.messages.hidden = false;
      addWelcomeMessage();

      const { resetGlobalProviderManager } = await import("../providers/provider-factory.js");
      resetGlobalProviderManager();

      setConnectionState({ status: "connecting", providerName: "" });
      const newState = await detectConfig();
      ctx.configState = newState;
      if (newState.hasProvider) {
        const status: ConnectionStatus = newState.isConnected ? "connected" : "offline";
        setConnectionState({ status, providerName: newState.providerName });

        if (newState.isConnected) {
          refreshProviderConfig();
          const { getActiveProviderState } = await import("../providers/active-state.js");
          getActiveProviderState().setActive(newState.providerName, getProviderActiveModel() || "auto", { autoDetected: true });
        }
      }
      initialHealthCheckDone = true;

      const { getProviderRegistry } = await import("../providers/provider-registry.js");
      getProviderRegistry().refreshAll().catch(() => {});

      await initSessionRouter(ctx, opts, layout, registry).catch(() => {});
      layout.tui.requestRender();
    });
    wizard.activate();
  } else {
    addWelcomeMessage();
  }

  return {
    instantConfig,
    initialHealthCheckDone,
    refreshProviderConfig,
    getProviderActiveModel,
  };
}

export function startTier2HealthPing(
  instantConfig: ReturnType<typeof checkConfigInstant>,
  ctx: AppContext,
  layout: AppLayout,
  refreshProviderConfig: () => void,
  getProviderActiveModel: () => string | null,
): void {
  if (!(instantConfig.hasProvider && instantConfig.hasKey)) return;

  const spinFrames = defaultTheme.symbols.spinner;
  let spinIdx = 0;
  let spinnerRunning = true;
  const connectSpinner = setInterval(() => {
    if (!spinnerRunning) return;
    spinIdx = (spinIdx + 1) % spinFrames.length;
    setConnectionState({ status: "connecting", providerName: instantConfig.providerName });
  }, 100);

  setTimeout(() => {
    mark("tier2 health ping start");
    pingProvider(5000).then(({ status, error }) => {
      clearInterval(connectSpinner);
      spinnerRunning = false;
      mark("tier2 health ping done");

      setConnectionState({ status, providerName: instantConfig.providerName });
      ctx.configState = {
        hasProvider: true,
        providerName: instantConfig.providerName,
        isConnected: status === "connected",
        error: error ?? null,
      };

      if (status === "connected") {
        refreshProviderConfig();
        import("../providers/active-state.js").then(({ getActiveProviderState }) => {
          getActiveProviderState().setActive(instantConfig.providerName, getProviderActiveModel() || "auto", { autoDetected: true });
        });
      } else if (status === "auth_failed") {
        showConfigWarning({
          hasProvider: true,
          providerName: instantConfig.providerName,
          isConnected: false,
          error: error ?? "API key invalid",
        }, layout);
      }
    }).catch(() => {
      clearInterval(connectSpinner);
      spinnerRunning = false;
      setConnectionState({ status: "error", providerName: instantConfig.providerName });
    });
  }, 100);
}
