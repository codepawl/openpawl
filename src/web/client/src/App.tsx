import { WebSocketProvider, useWsStore } from "./ws";
import { useTheme } from "./theme";
import { KanbanBoard } from "./components/KanbanBoard";
import { EisenhowerMatrix } from "./components/EisenhowerMatrix";
import { NodeGraphView } from "./components/NodeGraphView";
import { LiveStateGraph } from "./components/LiveStateGraph";
import { AlertCenter } from "./components/AlertCenter";
import { SettingsPanel } from "./components/SettingsPanel";
import { HumanApprovalModal } from "./components/HumanApprovalModal";
import { CostBadge } from "./components/CostBadge";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useState, useEffect, lazy, Suspense } from "react";

const ConsoleViewer = lazy(() => import("./components/ConsoleViewer").then((m) => ({ default: m.ConsoleViewer })));

type ActiveView = "dashboard" | "settings";

function Sidebar({
  activeView,
  setActiveView,
}: {
  activeView: ActiveView;
  setActiveView: (v: ActiveView) => void;
}) {
  return (
    <aside className="w-48 shrink-0 border-r border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-4 transition-colors duration-200 ease-in-out">
      <nav className="space-y-1">
        <button
          type="button"
          onClick={() => setActiveView("dashboard")}
          className={`block w-full rounded px-3 py-2 text-left text-sm font-medium transition-colors duration-200 ease-in-out ${
            activeView === "dashboard"
              ? "bg-gray-200 dark:bg-gray-600 text-gray-900 dark:text-gray-100"
              : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          }`}
        >
          Dashboard
        </button>
        <button
          type="button"
          onClick={() => setActiveView("settings")}
          className={`block w-full rounded px-3 py-2 text-left text-sm font-medium transition-colors duration-200 ease-in-out ${
            activeView === "settings"
              ? "bg-gray-200 dark:bg-gray-600 text-gray-900 dark:text-gray-100"
              : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          }`}
        >
          Settings
        </button>
      </nav>
    </aside>
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
      className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-200 ease-in-out"
    >
      {theme === "light" ? (
        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
        </svg>
      ) : theme === "dark" ? (
        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M3 5a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2h-2.22a.75.75 0 00-.75.75v-3.5a.75.75 0 00-.75-.75H6a.75.75 0 00-.75.75v3.5a.75.75 0 00-.75.75H2a2 2 0 01-2-2V5zm4.75 2.5a.75.75 0 00-.75.75v2.25c0 .414.336.75.75.75h2.25a.75.75 0 00.75-.75V8.25A.75.75 0 009.25 7.5H7z" clipRule="evenodd" />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}

function Topbar() {
  const connectionStatus = useWsStore((s) => s.connectionStatus);
  const cycle_count = useWsStore((s) => s.cycle_count);
  const statusLabel =
    connectionStatus === "open"
      ? "Connected"
      : connectionStatus === "reconnecting"
        ? "Reconnecting…"
        : connectionStatus === "connecting"
          ? "Connecting…"
          : connectionStatus === "error"
            ? "Error"
            : "Disconnected";
  const statusColor =
    connectionStatus === "open"
      ? "text-green-600 dark:text-green-400"
      : connectionStatus === "reconnecting" || connectionStatus === "connecting"
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 transition-colors duration-200 ease-in-out">
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Session</span>
      <div className="flex items-center gap-3">
        <CostBadge />
        <ThemeToggle />
        {connectionStatus === "open" && (
          <span className="text-xs text-gray-500 dark:text-gray-400">Cycle {cycle_count}</span>
        )}
        <span className={`text-sm font-medium ${statusColor}`}>{statusLabel}</span>
      </div>
    </header>
  );
}

function MainContent({ activeView }: { activeView: ActiveView }) {
  const [activeTab, setActiveTab] = useState<"matrix" | "graph" | "workflow">("matrix");

  if (activeView === "settings") {
    return (
      <main key="settings" className="flex-1 overflow-auto p-4 bg-gray-100 dark:bg-gray-900 transition-colors duration-200 ease-in-out" data-view="settings">
        <SettingsPanel />
      </main>
    );
  }

  return (
    <main key="dashboard" className="flex-1 overflow-hidden p-4 bg-gray-100 dark:bg-gray-900 transition-colors duration-200 ease-in-out" data-view="dashboard">
      <div className="flex h-full flex-col gap-4">
        <div className="min-h-[220px] flex-1">
          <KanbanBoard />
        </div>
        <div className="flex min-h-[260px] flex-1 flex-col rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-2 shadow-sm transition-colors duration-200 ease-in-out">
          <div className="mb-2 flex items-center gap-2 border-b border-gray-100 dark:border-gray-600 px-1 pb-1">
            <button
              type="button"
              onClick={() => setActiveTab("matrix")}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors duration-200 ease-in-out ${
                activeTab === "matrix"
                  ? "bg-gray-900 dark:bg-gray-700 text-white"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              Eisenhower Matrix
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("graph")}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors duration-200 ease-in-out ${
                activeTab === "graph"
                  ? "bg-gray-900 dark:bg-gray-700 text-white"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              Mind Map
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("workflow")}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors duration-200 ease-in-out ${
                activeTab === "workflow"
                  ? "bg-gray-900 dark:bg-gray-700 text-white"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              Workflow
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            {activeTab === "matrix" ? (
              <div className="h-full overflow-auto">
                <EisenhowerMatrix />
              </div>
            ) : activeTab === "graph" ? (
              <div className="h-full overflow-hidden">
                <NodeGraphView />
              </div>
            ) : (
              <div className="h-full overflow-auto">
                <LiveStateGraph />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Dashboard() {
  const [activeView, setActiveView] = useState<ActiveView>("dashboard");
  const [logsExpanded, setLogsExpanded] = useState(true);
  const connectionStatus = useWsStore((s) => s.connectionStatus);

  useEffect(() => {
    if (connectionStatus === "open") {
      setLogsExpanded(true);
    }
  }, [connectionStatus]);

  return (
    <div className="flex h-screen flex-col bg-gray-100 dark:bg-gray-900 transition-colors duration-200 ease-in-out">
      <Topbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar activeView={activeView} setActiveView={setActiveView} />
        <MainContent activeView={activeView} />
        <AlertCenter />
        <HumanApprovalModal />
      </div>
      <div className="shrink-0 border-t border-gray-200 dark:border-gray-600">
        <button
          type="button"
          onClick={() => setLogsExpanded(!logsExpanded)}
          className="flex w-full items-center justify-between px-4 py-1.5 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-200 border-b border-gray-200 dark:border-gray-600"
        >
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {logsExpanded ? "▼" : "▶"} Logs
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {logsExpanded ? "Hide" : "Show"}
          </span>
        </button>
        {logsExpanded && (
          <div className="h-[280px]">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center bg-[#1c1c1c] text-gray-500 text-sm">
                  Initializing Terminal...
                </div>
              }
            >
              <ConsoleViewer isExpanded={logsExpanded} />
            </Suspense>
          </div>
        )}
      </div>
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
