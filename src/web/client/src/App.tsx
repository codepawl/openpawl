import { WebSocketProvider, useWsStore } from "./ws";
import { useTheme } from "./theme";
import { KanbanBoard } from "./components/KanbanBoard";
import { PaletteSettings } from "./components/settings/PaletteSettings";
import { SummaryCards } from "./components/SummaryCards";
import { WorkflowStepper } from "./components/WorkflowStepper";
import { InsightsSection } from "./components/InsightsSection";
import { StandupPanel } from "./components/StandupPanel";
import { NotificationPanel } from "./components/NotificationPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { HumanApprovalModal } from "./components/HumanApprovalModal";
import { CostBadge } from "./components/CostBadge";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OpenClawLogPanel } from "./components/OpenClawLogPanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { useState, useEffect } from "react";
import { AnimatePresence } from "motion/react";
import { useResizable } from "./hooks/useResizable";

function ClawLogo({ size = 120 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 280 280"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="drop-shadow-2xl"
    >
      <rect x="60" y="80" width="30" height="100" rx="4" fill="var(--color-amber-500)" />
      <rect x="60" y="80" width="30" height="20" rx="4" fill="var(--color-amber-300)" />
      <rect x="125" y="60" width="30" height="120" rx="4" fill="var(--color-amber-500)" />
      <rect x="125" y="60" width="30" height="20" rx="4" fill="var(--color-amber-300)" />
      <rect x="190" y="80" width="30" height="100" rx="4" fill="var(--color-amber-500)" />
      <rect x="190" y="80" width="30" height="20" rx="4" fill="var(--color-amber-300)" />
      <rect x="70" y="170" width="140" height="50" rx="6" fill="var(--color-stone-300)" />
      <rect x="70" y="170" width="140" height="15" rx="6" fill="var(--color-stone-200)" />
      <rect x="95" y="185" width="8" height="25" rx="2" fill="var(--color-amber-500)" opacity="0.5" />
      <rect x="136" y="185" width="8" height="25" rx="2" fill="var(--color-amber-500)" opacity="0.5" />
      <rect x="177" y="185" width="8" height="25" rx="2" fill="var(--color-amber-500)" opacity="0.5" />
    </svg>
  );
}

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
    <header className="relative flex h-14 shrink-0 items-center justify-between border-b border-stone-200 dark:border-stone-700 bg-gradient-to-r from-white to-stone-50 dark:from-stone-900 dark:to-stone-950 px-6 transition-colors">
      <div className="flex items-center gap-2">
        <ClawLogo size={24} />
        <span className={`inline-block h-2 w-2 rounded-full ${statusColor.replace("text-", "bg-")}${connectionStatus === "open" ? " animate-breathe" : ""}`} />
        <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">TeamClaw</span>
      </div>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3">
        {connectionStatus === "open" && (
          <span className="text-xs font-medium text-stone-600 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 rounded-full px-2 py-0.5">
            {cycle_count === 0 ? "Idle" : `Cycle ${cycle_count}`}
          </span>
        )}
        {cycle_count > 0 && <WorkflowStepper />}
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

function GatewayBanner() {
  const gatewayAvailable = useWsStore((s) => s.gatewayAvailable);
  if (gatewayAvailable) return null;

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2">
      <i className="bi bi-exclamation-triangle text-base" />
      <span>OpenClaw Gateway not connected — start the gateway to run sessions.</span>
    </div>
  );
}

function DashboardSettings({ onDismiss }: { onDismiss: () => void }) {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex min-h-full items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-stone-200 dark:border-stone-700 bg-gradient-to-br from-white to-stone-50 dark:from-stone-900 dark:to-stone-950 p-6 shadow-sm space-y-5">
        <div className="flex flex-col items-center space-y-4">
          <ClawLogo size={120} />
          <div className="text-center space-y-1">
            <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-100">
              Dashboard Settings
            </h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Customize your dashboard appearance.
            </p>
          </div>
          <GatewayBanner />
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-xs font-medium text-stone-600 dark:text-stone-400">
              Theme
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(["light", "dark", "system"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTheme(t)}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    theme === t
                      ? "border-amber-500 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                      : "border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800"
                  }`}
                >
                  <i className={`bi ${t === "light" ? "bi-sun-fill" : t === "dark" ? "bi-moon-fill" : "bi-display"} text-sm`} />
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <PaletteSettings />
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className="w-full rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-medium py-2 text-sm transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Dashboard() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [settingsDismissed, setSettingsDismissed] = useState(
    () => localStorage.getItem("teamclaw-settings-dismissed") === "true",
  );
  const cycle_count = useWsStore((s) => s.cycle_count);
  const alerts = useWsStore((s) => s.alerts);
  const pendingApproval = useWsStore((s) => s.pendingApproval);

  const { height: panelHeight, isDragging, handleProps } = useResizable({
    minHeight: 120,
    maxHeight: window.innerHeight * 0.7,
    initialHeight: 280,
    storageKey: "teamclaw-panel-height",
  });

  const notificationCount = alerts.filter((a) => !a.read).length + (pendingApproval ? 1 : 0);

  useEffect(() => {
    if (cycle_count > 0) {
      setLogsExpanded(true);
    } else {
      setLogsExpanded(false);
    }
  }, [cycle_count]);

  return (
    <div className="flex h-screen flex-col bg-gradient-to-br from-stone-50 via-stone-50 to-stone-100 dark:from-stone-950 dark:via-stone-950 dark:to-stone-900 transition-colors">
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

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-auto px-6 py-4 space-y-4">
          <ServerRestartBanner />
          <ApprovalBanner />
          {cycle_count === 0 && !settingsDismissed ? (
            <DashboardSettings onDismiss={() => { setSettingsDismissed(true); localStorage.setItem("teamclaw-settings-dismissed", "true"); }} />
          ) : (
            <>
              <PreviewPanel />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <StandupPanel />
              </div>
              <SummaryCards />
              <KanbanBoard />
              <InsightsSection />
            </>
          )}
        </main>
        <AnimatePresence>
          {settingsOpen && (
            <SettingsPanel key="settings" onClose={() => setSettingsOpen(false)} />
          )}
        </AnimatePresence>
      </div>

      <div className="shrink-0 border-t border-stone-200 dark:border-stone-700">
        <div className="flex items-center justify-between px-6 py-0 bg-gradient-to-r from-white to-stone-50 dark:from-stone-900 dark:to-stone-950 border-b border-stone-200 dark:border-stone-700">
          <span className="px-3 py-2 text-xs font-medium text-stone-800 dark:text-stone-100">
            <i className="bi bi-journal-text mr-1" />Logs
          </span>
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
              <OpenClawLogPanel />
            </div>
          </>
        )}
      </div>

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
