import { useState, useMemo } from "react";

interface Decision {
  id: string;
  sessionId: string;
  runIndex: number;
  capturedAt: number;
  topic: string;
  decision: string;
  reasoning: string;
  recommendedBy: string;
  confidence: number;
  taskId: string;
  goalContext: string;
  tags: string[];
  supersededBy?: string;
  status: "active" | "superseded" | "reconsidered";
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: Decision["status"] }) {
  const colors: Record<string, string> = {
    active: "var(--green, #4ade80)",
    superseded: "var(--yellow, #facc15)",
    reconsidered: "var(--blue, #60a5fa)",
  };
  return (
    <span
      style={{
        fontSize: "0.7rem",
        padding: "0.15rem 0.4rem",
        borderRadius: "3px",
        background: `${colors[status] ?? "#888"}22`,
        color: colors[status] ?? "#888",
        textTransform: "uppercase",
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function DecisionCard({
  decision,
  expanded,
  onToggle,
  onReconsider,
}: {
  decision: Decision;
  expanded: boolean;
  onToggle: () => void;
  onReconsider: (id: string) => void;
}) {
  const confPct = Math.round(decision.confidence * 100);

  return (
    <div
      style={{
        background: "var(--card-bg, #1e1e2e)",
        border: "1px solid var(--border, #2a2a4a)",
        borderRadius: "6px",
        padding: "0.75rem",
        cursor: "pointer",
      }}
      onClick={onToggle}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{decision.decision}</div>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted, #888)" }}>
            {decision.recommendedBy} &middot; {confPct}% confidence &middot;{" "}
            {formatDate(decision.capturedAt)}
          </div>
        </div>
        <StatusBadge status={decision.status} />
      </div>

      {expanded && (
        <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Topic:</strong> {decision.topic}
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Reasoning:</strong> {decision.reasoning}
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Session:</strong> {decision.sessionId.slice(0, 20)} &mdash; {decision.goalContext.slice(0, 80)}
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Task:</strong> {decision.taskId} &middot; <strong>Run:</strong> {decision.runIndex}
          </div>
          {decision.tags.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              {decision.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    display: "inline-block",
                    fontSize: "0.7rem",
                    padding: "0.1rem 0.35rem",
                    borderRadius: "3px",
                    background: "var(--accent, #4f46e5)22",
                    color: "var(--accent, #4f46e5)",
                    marginRight: "0.3rem",
                    marginBottom: "0.2rem",
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {decision.supersededBy && (
            <div style={{ color: "var(--yellow, #facc15)" }}>
              Superseded by: {decision.supersededBy.slice(0, 12)}...
            </div>
          )}
          {decision.status === "active" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReconsider(decision.id);
              }}
              style={{
                marginTop: "0.5rem",
                background: "transparent",
                border: "1px solid var(--yellow, #facc15)",
                color: "var(--yellow, #facc15)",
                borderRadius: "4px",
                padding: "0.25rem 0.5rem",
                cursor: "pointer",
                fontSize: "0.75rem",
              }}
            >
              Mark as Reconsidered
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function JournalPanel({ decisions }: { decisions: Decision[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Decision["status"]>("all");
  const [agentFilter, setAgentFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const agents = useMemo(
    () => [...new Set(decisions.map((d) => d.recommendedBy))],
    [decisions],
  );

  const filtered = useMemo(() => {
    let result = decisions;

    if (statusFilter !== "all") {
      result = result.filter((d) => d.status === statusFilter);
    }

    if (agentFilter) {
      result = result.filter((d) => d.recommendedBy === agentFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((d) =>
        `${d.decision} ${d.topic} ${d.reasoning} ${d.tags.join(" ")}`
          .toLowerCase()
          .includes(q),
      );
    }

    return result.sort((a, b) => b.capturedAt - a.capturedAt);
  }, [decisions, statusFilter, agentFilter, search]);

  const handleReconsider = (id: string) => {
    // In a full implementation this would call the API
    // For now just log it
    console.log(`Reconsider decision: ${id}`);
  };

  return (
    <div style={{ padding: "1rem" }}>
      <h3 style={{ margin: "0 0 0.75rem", color: "var(--cyan, #00d4ff)" }}>
        Decision Journal ({decisions.length})
      </h3>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search decisions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: "150px",
            padding: "0.4rem 0.6rem",
            background: "var(--input-bg, #2a2a3e)",
            border: "1px solid var(--border, #3a3a5a)",
            borderRadius: "4px",
            color: "var(--text, #e0e0e0)",
            fontSize: "0.85rem",
          }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | Decision["status"])}
          style={{
            padding: "0.4rem",
            background: "var(--input-bg, #2a2a3e)",
            border: "1px solid var(--border, #3a3a5a)",
            borderRadius: "4px",
            color: "var(--text, #e0e0e0)",
            fontSize: "0.85rem",
          }}
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="superseded">Superseded</option>
          <option value="reconsidered">Reconsidered</option>
        </select>
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          style={{
            padding: "0.4rem",
            background: "var(--input-bg, #2a2a3e)",
            border: "1px solid var(--border, #3a3a5a)",
            borderRadius: "4px",
            color: "var(--text, #e0e0e0)",
            fontSize: "0.85rem",
          }}
        >
          <option value="">All Agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: "var(--text-muted, #888)", textAlign: "center", padding: "2rem 0" }}>
          {decisions.length === 0 ? "No decisions captured yet." : "No decisions match filters."}
        </p>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {filtered.map((d) => (
            <DecisionCard
              key={d.id}
              decision={d}
              expanded={expandedId === d.id}
              onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
              onReconsider={handleReconsider}
            />
          ))}
        </div>
      )}
    </div>
  );
}
