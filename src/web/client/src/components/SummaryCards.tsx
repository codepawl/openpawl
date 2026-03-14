import { useWsStore } from "../ws";
import { motion } from "motion/react";

export function SummaryCards() {
  const task_queue = useWsStore((s) => s.task_queue);

  const total = task_queue.length;
  const active = task_queue.filter((t) => (t.status as string) === "in_progress").length;
  const attention = task_queue.filter((t) => {
    const s = t.status as string;
    return s === "needs_approval" || s === "TIMEOUT_WARNING";
  }).length;
  const done = task_queue.filter((t) => {
    const s = t.status as string;
    return s === "completed" || s === "failed";
  }).length;

  const cards = [
    { label: "Total", value: total, accent: false, icon: "bi-list-task" },
    { label: "Active", value: active, accent: false, icon: "bi-lightning-charge-fill" },
    { label: "Attention", value: attention, accent: attention > 0, icon: "bi-exclamation-triangle-fill" },
    { label: "Done", value: done, accent: false, icon: "bi-check-circle-fill" },
  ];

  const containerVariants = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.04 } },
  };

  const cardVariants = {
    hidden: { y: 6, opacity: 0 },
    visible: { y: 0, opacity: 1 },
  };

  return (
    <motion.div
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {cards.map((c) => (
        <motion.div
          key={c.label}
          className={`rounded-xl bg-white dark:bg-stone-900 border p-4 shadow-sm transition-colors ${
            c.accent ? "border-amber-400" : "border-stone-200 dark:border-stone-700"
          }`}
          variants={cardVariants}
          transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
        >
          <div className="flex items-center justify-between">
            <div className="text-2xl font-semibold text-stone-800 dark:text-stone-100">{c.value}</div>
            <i className={`bi ${c.icon} text-lg ${c.accent ? "text-amber-500" : "text-stone-400 dark:text-stone-500"}`} />
          </div>
          <div className="text-xs text-stone-500 dark:text-stone-400">{c.label}</div>
        </motion.div>
      ))}
    </motion.div>
  );
}
