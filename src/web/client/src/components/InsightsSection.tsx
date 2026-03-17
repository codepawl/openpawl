import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EisenhowerMatrix } from "./EisenhowerMatrix";
import { NodeGraphView } from "./NodeGraphView";
import { LiveStateGraph } from "./LiveStateGraph";
import { MemoryPanel } from "./MemoryPanel";
import { ProfilesPanel } from "./ProfilesPanel";
import { ThinkPanel } from "./ThinkPanel";

const TAB_CONFIG = {
  matrix: { icon: "bi-grid-3x3-gap-fill", label: "Priority Matrix" },
  graph: { icon: "bi-diagram-3", label: "Task Graph" },
  workflow: { icon: "bi-signpost-split", label: "Roadmap" },
  memory: { icon: "bi-database", label: "Memory" },
  profiles: { icon: "bi-person-badge", label: "Profiles" },
  think: { icon: "bi-chat-square-dots", label: "Think" },
} as const;

type InsightsTab = keyof typeof TAB_CONFIG;

export function InsightsSection() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<InsightsTab>("matrix");

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-sm transition-colors">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-stone-600 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 transition-colors"
      >
        <i className={`bi ${open ? "bi-chevron-down" : "bi-chevron-right"} text-xs`} />
        <i className="bi bi-graph-up text-xs" />
        {open ? "Hide insights" : "Show insights"}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            key="insights"
            className="border-t border-stone-200 dark:border-stone-700 p-4 overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
          >
          <div className="mb-3 flex items-center gap-2">
            {(Object.keys(TAB_CONFIG) as InsightsTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab
                    ? "bg-stone-800 dark:bg-stone-700 text-white"
                    : "text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
                }`}
              >
                <i className={`bi ${TAB_CONFIG[tab].icon} mr-1`} />
                {TAB_CONFIG[tab].label}
              </button>
            ))}
          </div>
          <div className="min-h-[300px]">
            {activeTab === "matrix" ? (
              <EisenhowerMatrix />
            ) : activeTab === "graph" ? (
              <div className="h-[400px]">
                <NodeGraphView />
              </div>
            ) : activeTab === "workflow" ? (
              <LiveStateGraph />
            ) : activeTab === "memory" ? (
              <MemoryPanel />
            ) : activeTab === "profiles" ? (
              <ProfilesPanel />
            ) : (
              <ThinkPanel />
            )}
          </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
