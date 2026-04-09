import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";

interface BriefingData {
  lastSession: {
    sessionId: string;
    goal: string;
    daysAgo: number;
    tasksCompleted: number;
  } | null;
  whatWasBuilt: string[];
  teamLearnings: string[];
  leftOpen: { taskDescription: string; reason: string }[];
  teamPerformance: { agentRole: string; trend: string; confidenceDelta: number; alert: boolean }[];
  newGlobalPatterns: number;
  openRFCs: string[];
  relevantDecisions?: { decision: string; recommendedBy: string; date: string }[];
}

export function SessionBriefing({
  data,
  onDismiss,
}: {
  data: BriefingData | null;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(true);

  if (!visible || !data) return null;

  const handleDismiss = () => {
    setVisible(false);
    onDismiss();
  };

  const isFirstTime = !data.lastSession;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="briefing-panel"
          style={{
            background: "var(--card-bg, #1a1a2e)",
            border: "1px solid var(--border, #2a2a4a)",
            borderRadius: "8px",
            padding: "1.25rem",
            margin: "0.75rem 0",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <h3 style={{ margin: 0, color: "var(--cyan, #00d4ff)", fontSize: "1rem" }}>
              {isFirstTime ? "Welcome to TeamClaw" : "Previously on TeamClaw"}
            </h3>
            <button
              onClick={handleDismiss}
              style={{
                background: "var(--accent, #4f46e5)",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                padding: "0.35rem 0.75rem",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              Start Session
            </button>
          </div>

          {isFirstTime ? (
            <p style={{ color: "var(--text-muted, #888)", margin: 0, fontSize: "0.85rem" }}>
              Your AI team is ready. No previous sessions found. Your team remembers everything from here on.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "0.5rem", fontSize: "0.85rem" }}>
              <p style={{ color: "var(--text-muted, #888)", margin: 0 }}>
                Last session: {data.lastSession!.daysAgo === 0 ? "today" : data.lastSession!.daysAgo === 1 ? "yesterday" : `${data.lastSession!.daysAgo} days ago`}
                {" "}({data.lastSession!.sessionId.slice(0, 16)})
              </p>

              {data.whatWasBuilt.length > 0 && (
                <div>
                  <strong style={{ color: "var(--text, #e0e0e0)" }}>What was built:</strong>
                  {data.whatWasBuilt.slice(0, 3).map((item, i) => (
                    <div key={i} style={{ color: "var(--green, #4ade80)", paddingLeft: "0.75rem" }}>→ {item}</div>
                  ))}
                </div>
              )}

              {data.teamLearnings.length > 0 && (
                <div>
                  <strong style={{ color: "var(--text, #e0e0e0)" }}>What the team learned:</strong>
                  {data.teamLearnings.slice(0, 2).map((lesson, i) => (
                    <div key={i} style={{ color: "var(--blue, #60a5fa)", paddingLeft: "0.75rem" }}>
                      → {lesson.length > 80 ? lesson.slice(0, 77) + "..." : lesson}
                    </div>
                  ))}
                </div>
              )}

              {data.leftOpen.length > 0 && (
                <div>
                  <strong style={{ color: "var(--text, #e0e0e0)" }}>Left open:</strong>
                  {data.leftOpen.slice(0, 2).map((item, i) => (
                    <div key={i} style={{ color: "var(--yellow, #facc15)", paddingLeft: "0.75rem" }}>
                      → &quot;{item.taskDescription.length > 50 ? item.taskDescription.slice(0, 47) + "..." : item.taskDescription}&quot; — {item.reason}
                    </div>
                  ))}
                </div>
              )}

              {data.teamPerformance.filter((tp) => tp.trend !== "stable").slice(0, 2).map((entry, i) => (
                <div
                  key={i}
                  style={{
                    color: entry.trend === "degrading" || entry.alert
                      ? "var(--red, #f87171)"
                      : "var(--green, #4ade80)",
                    paddingLeft: "0.75rem",
                  }}
                >
                  → {entry.agentRole}{" "}
                  {entry.trend === "degrading" || entry.alert
                    ? "below threshold — watch this"
                    : `trending up (+${entry.confidenceDelta.toFixed(2)} confidence)`}
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
