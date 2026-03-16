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

  const tasksWithConfidence = task_queue.filter((t) => {
    const r = t.result as Record<string, unknown> | null;
    if (!r) return false;
    const conf = r.confidence as Record<string, unknown> | undefined;
    return conf && typeof conf.score === "number";
  });
  const avgConfidence =
    tasksWithConfidence.length > 0
      ? Math.round(
          (tasksWithConfidence.reduce((sum, t) => {
            const r = t.result as Record<string, unknown>;
            const conf = r.confidence as Record<string, unknown>;
            return sum + (conf.score as number);
          }, 0) / tasksWithConfidence.length) * 100,
        )
      : -1;

  const autoApproved = task_queue.filter((t) => {
    const r = t.result as Record<string, unknown> | null;
    return r?.routing_decision === "auto_approved" && (t.status as string) === "completed";
  }).length;
  const deferred = task_queue.filter((t) => (t.status as string) === "escalated").length;

  const cards = [
    { label: "Total", value: total, accent: false, icon: "bi-list-task" },
    { label: "Active", value: active, accent: false, icon: "bi-lightning-charge-fill" },
    { label: "Attention", value: attention, accent: attention > 0, icon: "bi-exclamation-triangle-fill" },
    { label: "Done", value: done, accent: false, icon: "bi-check-circle-fill" },
    ...(autoApproved > 0
      ? [{ label: "Auto-Approved", value: autoApproved, accent: false, icon: "bi-robot" }]
      : []),
    ...(deferred > 0
      ? [{ label: "Deferred", value: deferred, accent: deferred > 0, icon: "bi-clock-history" }]
      : []),
    ...(avgConfidence >= 0
      ? [{ label: "Confidence", value: `${avgConfidence}%`, accent: avgConfidence < 60, icon: "bi-speedometer2" }]
      : []),
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
      className={`grid grid-cols-2 gap-3 ${cards.length >= 7 ? "sm:grid-cols-7" : cards.length >= 6 ? "sm:grid-cols-6" : cards.length > 4 ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {cards.map((c) => (
        <motion.div
          key={c.label}
          className={`rounded-xl bg-gradient-to-br from-white to-stone-50 dark:from-stone-900 dark:to-stone-950 border p-4 shadow-sm transition-colors ${
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
