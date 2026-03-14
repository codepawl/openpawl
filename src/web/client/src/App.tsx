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
import { getApiBase } from "./utils/api";
import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from "react";
import { AnimatePresence } from "motion/react";
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
    <header className="relative flex h-14 shrink-0 items-center justify-between border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-6 transition-colors">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${statusColor.replace("text-", "bg-")}${connectionStatus === "open" ? " animate-breathe" : ""}`} />
        <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">TeamClaw</span>
      </div>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3">
        {connectionStatus === "open" && (
          <span className="text-xs text-stone-500 dark:text-stone-400">Cycle {cycle_count}</span>
        )}
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

const inputClass = "w-full rounded-lg border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 text-sm text-stone-800 dark:text-stone-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150 placeholder:text-stone-400 dark:placeholder:text-stone-500";
const selectClass = "w-full appearance-none rounded-lg border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 pr-9 text-sm text-stone-800 dark:text-stone-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150 bg-[length:16px_16px] bg-[position:right_0.625rem_center] bg-no-repeat bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='%2378716c' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m2 5 6 6 6-6'/%3E%3C/svg%3E\")]";

function ReadyToStart() {
  const config = useWsStore((s) => s.config);
  const sendMessage = useWsStore((s) => s.sendMessage);
  const setLastError = useWsStore((s) => s.setLastError);

  const [template, setTemplate] = useState(
    (config?.saved_template as string) ?? "game_dev"
  );
  const [goal, setGoal] = useState((config?.saved_goal as string) ?? "");
  const [creativity, setCreativity] = useState(
    Number(config?.creativity ?? 0.5)
  );
  const [maxCycles, setMaxCycles] = useState(
    Number(config?.max_cycles ?? 10)
  );
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!config) return;
    setTemplate((config.saved_template as string) ?? "game_dev");
    setGoal((config.saved_goal as string) ?? "");
    const c = Number(config.creativity);
    const mc = Number(config.max_cycles);
    if (Number.isFinite(c)) setCreativity(c);
    if (Number.isFinite(mc)) setMaxCycles(mc);
  }, [config]);

  const dirtyFields = useMemo(() => {
    if (!config) return { template: false, goal: false, creativity: false, maxCycles: false };
    return {
      template: template !== ((config.saved_template as string) ?? "game_dev"),
      goal: goal !== ((config.saved_goal as string) ?? ""),
      creativity: creativity !== Number(config.creativity ?? 0.5),
      maxCycles: maxCycles !== Number(config.max_cycles ?? 10),
    };
  }, [config, template, goal, creativity, maxCycles]);

  const isDirty = dirtyFields.template || dirtyFields.goal || dirtyFields.creativity || dirtyFields.maxCycles;

  async function handleStart() {
    setStatus("saving");
    setErrorMsg("");
    setLastError(null);

    const base = getApiBase();

    if (isDirty) {
      try {
        const res = await fetch(`${base}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template,
            goal: goal.trim(),
            creativity: Math.max(0, Math.min(1, creativity)),
            max_cycles: Math.max(1, Math.floor(maxCycles)),
          }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!data.ok) {
          setStatus("error");
          setErrorMsg(data.error ?? `HTTP ${res.status}`);
          setLastError(data.error ?? "Failed to save config");
          return;
        }
      } catch (err) {
        setStatus("error");
        setErrorMsg(String(err));
        setLastError(String(err));
        return;
      }

      sendMessage({
        command: "config",
        values: {
          creativity: Math.max(0, Math.min(1, creativity)),
          max_cycles: Math.max(1, Math.floor(maxCycles)),
        },
      });
    }

    sendMessage({ command: "start" });
    setStatus("idle");
  }

  const dirtyHint = (
    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
      Modified — will be saved on start
    </p>
  );

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-6 shadow-sm space-y-5">
        <div className="text-center space-y-1">
          <i className="bi bi-rocket-takeoff text-2xl text-amber-500" />
          <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-100">
            Ready to start
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Configure your session and launch when ready.
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="ready-template" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
              Team Template
            </label>
            <select
              id="ready-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className={selectClass}
            >
              <option value="game_dev">Game Dev (Programmers, Artist, SFX, Designer)</option>
              <option value="startup">Startup (Engineers, PM, Designer)</option>
              <option value="content">Content (Writer, Editor, Designer)</option>
            </select>
            {dirtyFields.template && dirtyHint}
          </div>

          <div>
            <label htmlFor="ready-goal" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
              Goal
            </label>
            <textarea
              id="ready-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={2}
              placeholder="e.g. Build a simple 2D platformer with sprite assets and sound effects"
              className={inputClass}
            />
            {dirtyFields.goal && dirtyHint}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ready-creativity" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                Creativity (0-1)
              </label>
              <input
                id="ready-creativity"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={creativity}
                onChange={(e) => setCreativity(Number(e.target.value) || 0)}
                className={inputClass}
              />
              {dirtyFields.creativity && dirtyHint}
            </div>
            <div>
              <label htmlFor="ready-max-cycles" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
                Max Cycles
              </label>
              <input
                id="ready-max-cycles"
                type="number"
                min={1}
                value={maxCycles}
                onChange={(e) => setMaxCycles(Number(e.target.value) || 1)}
                className={inputClass}
              />
              {dirtyFields.maxCycles && dirtyHint}
            </div>
          </div>

          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <PaletteSettings />
          </div>
        </div>

        {status === "error" && (
          <div className="rounded-lg border border-rose-300 dark:border-rose-600 bg-rose-50 dark:bg-rose-900/30 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
            {errorMsg}
          </div>
        )}

        <button
          type="button"
          onClick={handleStart}
          disabled={status === "saving"}
          className="w-full rounded-lg bg-amber-500 hover:bg-amber-600 active:scale-[0.98] disabled:opacity-50 px-4 py-2.5 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/30"
        >
          {status === "saving" ? (
            <><i className="bi bi-arrow-repeat animate-spin mr-1.5" />Saving...</>
          ) : (
            <><i className="bi bi-play-fill mr-1.5" />Start Session</>
          )}
        </button>
      </div>
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

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-auto px-6 py-4 space-y-4">
          <ServerRestartBanner />
          <ApprovalBanner />
          {cycle_count === 0 ? (
            <ReadyToStart />
          ) : (
            <>
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
