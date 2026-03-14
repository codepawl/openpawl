import { WebSocketProvider, useWsStore } from "./ws";
import { useTheme } from "./theme";
import { KanbanBoard } from "./components/KanbanBoard";
import { PaletteSettings } from "./components/settings/PaletteSettings";
import { SummaryCards } from "./components/SummaryCards";
import { WorkflowStepper } from "./components/WorkflowStepper";
import { InsightsSection } from "./components/InsightsSection";
import { NotificationPanel } from "./components/NotificationPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { HumanApprovalModal } from "./components/HumanApprovalModal";
import { CostBadge } from "./components/CostBadge";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { useResizable } from "./hooks/useResizable";
import type { ConsoleViewerHandle } from "./components/ConsoleViewer";

const ConsoleViewer = lazy(() => import("./components/ConsoleViewer").then((m) => ({ default: m.ConsoleViewer })));
const OpenClawLogPanel = lazy(() => import("./components/OpenClawLogPanel").then((m) => ({ default: m.OpenClawLogPanel })));

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const cycle = () => {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";
  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${label} (click to cycle)`}
      className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
    >
      {theme === "light" ? (
        <i className="bi bi-sun-fill text-sm" />
      ) : theme === "dark" ? (
        <i className="bi bi-moon-fill text-sm" />
      ) : (
        <i className="bi bi-display text-sm" />
      )}
      <span>{label}</span>
    </button>
  );
}

function Topbar({
  onToggleSettings,
  onToggleNotifications,
  notificationCount,
}: {
  onToggleSettings: () => void;
  onToggleNotifications: () => void;
  notificationCount: number;
}) {
  const connectionStatus = useWsStore((s) => s.connectionStatus);
  const cycle_count = useWsStore((s) => s.cycle_count);
  const statusColor =
    connectionStatus === "open"
      ? "text-emerald-500 dark:text-emerald-400"
      : connectionStatus === "reconnecting" || connectionStatus === "connecting"
        ? "text-amber-500 dark:text-amber-400"
        : "text-rose-500 dark:text-rose-400";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-6 transition-colors">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${statusColor.replace("text-", "bg-")}${connectionStatus === "open" ? " animate-breathe" : ""}`} />
          <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">TeamClaw</span>
          {connectionStatus === "open" && (
            <span className="text-xs text-stone-500 dark:text-stone-400">Cycle {cycle_count}</span>
          )}
        </div>
        <WorkflowStepper />
      </div>
      <div className="flex items-center gap-2">
        <CostBadge />
        <ThemeToggle />
        <button
          type="button"
          onClick={onToggleSettings}
          className="rounded-lg p-1.5 text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400/20"
          title="Settings"
        >
          <i className="bi bi-gear text-base" />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={onToggleNotifications}
            className="rounded-lg p-1.5 text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400/20"
            title="Notifications"
          >
            <i className="bi bi-bell text-base" />
            {notificationCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-medium text-white animate-badge-pop">
                {notificationCount > 9 ? "9+" : notificationCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

function ServerRestartBanner() {
  const serverRestarted = useWsStore((s) => s.serverRestarted);
  const dismiss = useWsStore((s) => s.dismissServerRestart);
  if (!serverRestarted) return null;

  return (
    <div className="rounded-xl border border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/30 px-4 py-3 text-sm text-blue-800 dark:text-blue-200 animate-drop-in flex items-center justify-between">
      <span>
        <span className="font-medium">Server restarted</span> — The dashboard may be out of date.{" "}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="underline font-medium hover:text-blue-600 dark:hover:text-blue-100"
        >
          Refresh now
        </button>
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="ml-4 text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
        title="Dismiss"
      >
        <i className="bi bi-x-lg text-sm" />
      </button>
    </div>
  );
}

function ApprovalBanner() {
  const pendingApproval = useWsStore((s) => s.pendingApproval);
  if (!pendingApproval) return null;

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 animate-drop-in">
      <span className="font-medium">Approval required</span> — {(pendingApproval.description as string) ?? "A task needs your attention."}
    </div>
  );
}

function Dashboard() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(true);
  const [consoleTab, setConsoleTab] = useState<"terminal" | "openclaw">("terminal");
  const connectionStatus = useWsStore((s) => s.connectionStatus);
  const cycle_count = useWsStore((s) => s.cycle_count);
  const alerts = useWsStore((s) => s.alerts);
  const pendingApproval = useWsStore((s) => s.pendingApproval);

  const consoleRef = useRef<ConsoleViewerHandle>(null);
  const fitTerminal = useCallback(() => consoleRef.current?.fit(), []);
  const { height: panelHeight, isDragging, handleProps } = useResizable({
    minHeight: 120,
    maxHeight: window.innerHeight * 0.7,
    initialHeight: 280,
    storageKey: "teamclaw-panel-height",
    onResizeEnd: fitTerminal,
  });

  const notificationCount = alerts.filter((a) => !a.read).length + (pendingApproval ? 1 : 0);

  useEffect(() => {
    if (connectionStatus === "open") {
      setLogsExpanded(true);
    }
  }, [connectionStatus]);

  return (
    <div className="flex h-screen flex-col bg-stone-50 dark:bg-stone-950 transition-colors">
      <div className="relative">
        <Topbar
          onToggleSettings={() => { setSettingsOpen(!settingsOpen); setNotificationsOpen(false); }}
          onToggleNotifications={() => { setNotificationsOpen(!notificationsOpen); setSettingsOpen(false); }}
          notificationCount={notificationCount}
        />
        <div className="absolute right-6 top-14 z-30">
          <NotificationPanel open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
        </div>
      </div>

      <main className="flex-1 overflow-auto px-6 py-4 space-y-4">
        <ServerRestartBanner />
        <ApprovalBanner />
        {cycle_count === 0 ? (
          <div className="flex flex-1 items-center justify-center pt-16">
            <div className="w-full max-w-sm space-y-4 text-center">
              <h2 className="text-lg font-semibold text-stone-700 dark:text-stone-300">
                Ready to start
              </h2>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                Configure your workspace or pick a color palette.
              </p>
              <div className="text-left">
                <PaletteSettings />
              </div>
            </div>
          </div>
        ) : (
          <>
            <SummaryCards />
            <KanbanBoard />
            <InsightsSection />
          </>
        )}
      </main>

      <div className="shrink-0 border-t border-stone-200 dark:border-stone-700">
        <div className="flex items-center justify-between px-6 py-0 bg-white dark:bg-stone-900 border-b border-stone-200 dark:border-stone-700">
          <div className="flex items-center gap-0">
            <button
              type="button"
              onClick={() => { setLogsExpanded(true); setConsoleTab("terminal"); }}
              className={`px-3 py-2 text-xs font-medium transition-colors ${
                consoleTab === "terminal" && logsExpanded
                  ? "text-stone-800 dark:text-stone-100 border-b-2 border-stone-800 dark:border-stone-100"
                  : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
              }`}
            >
              <i className="bi bi-terminal mr-1" />Console
            </button>
            <button
              type="button"
              onClick={() => { setLogsExpanded(true); setConsoleTab("openclaw"); }}
              className={`px-3 py-2 text-xs font-medium transition-colors ${
                consoleTab === "openclaw" && logsExpanded
                  ? "text-stone-800 dark:text-stone-100 border-b-2 border-stone-800 dark:border-stone-100"
                  : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
              }`}
            >
              <i className="bi bi-globe2 mr-1" />OpenClaw Logs
            </button>
          </div>
          <button
            type="button"
            onClick={() => setLogsExpanded(!logsExpanded)}
            className="text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors py-2"
          >
            {logsExpanded ? "Hide" : "Show"}
          </button>
        </div>
        {logsExpanded && (
          <>
            <div className="resize-handle" {...handleProps}>
              <div className="resize-handle-indicator" />
            </div>
            <div style={{ height: panelHeight }} className={isDragging ? "pointer-events-none" : ""}>
              {consoleTab === "terminal" ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center bg-[#1c1c1c] text-stone-500 text-sm">
                      Initializing Terminal...
                    </div>
                  }
                >
                  <ConsoleViewer ref={consoleRef} />
                </Suspense>
              ) : (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center bg-stone-50 dark:bg-stone-950 text-stone-500 text-sm">
                      Loading OpenClaw Logs...
                    </div>
                  }
                >
                  <OpenClawLogPanel />
                </Suspense>
              )}
            </div>
          </>
        )}
      </div>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HumanApprovalModal />
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <WebSocketProvider>
        <Dashboard />
      </WebSocketProvider>
    </ErrorBoundary>
  );
}

export default App;
