import { useState } from "react";

interface ClarityIssue {
  type: string;
  fragment: string;
  question: string;
  severity: "blocking" | "advisory";
}

interface ClarityResult {
  isClear: boolean;
  score: number;
  issues: ClarityIssue[];
  suggestions: string[];
  checkedAt: number;
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 0.8
    ? "var(--green, #4ade80)"
    : score >= 0.5
      ? "var(--yellow, #facc15)"
      : "var(--red, #f87171)";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--text-muted, #888)", minWidth: "4rem" }}>
        Clarity
      </span>
      <div style={{
        flex: 1, height: "6px", borderRadius: "3px",
        background: "var(--border, #3a3a5a)",
        overflow: "hidden",
      }}>
        <div style={{
          width: `${Math.round(score * 100)}%`, height: "100%",
          background: color, borderRadius: "3px",
          transition: "width 0.3s ease",
        }} />
      </div>
      <span style={{ fontSize: "0.75rem", color, minWidth: "2.5rem", textAlign: "right" }}>
        {Math.round(score * 100)}%
      </span>
    </div>
  );
}

function IssueCard({ issue }: { issue: ClarityIssue }) {
  const isBlocking = issue.severity === "blocking";
  const badgeColor = isBlocking ? "var(--red, #f87171)" : "var(--yellow, #facc15)";

  return (
    <div style={{
      background: "var(--card-bg, #1e1e2e)",
      border: `1px solid ${badgeColor}44`,
      borderRadius: "6px",
      padding: "0.6rem 0.75rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.25rem" }}>
        <span style={{
          fontSize: "0.65rem", padding: "0.1rem 0.3rem", borderRadius: "3px",
          background: `${badgeColor}22`, color: badgeColor,
          textTransform: "uppercase", fontWeight: 600,
        }}>
          {issue.severity}
        </span>
        <span style={{
          fontSize: "0.65rem", padding: "0.1rem 0.3rem", borderRadius: "3px",
          background: "var(--border, #3a3a5a)",
          color: "var(--text-muted, #888)",
        }}>
          {issue.type.replace(/_/g, " ")}
        </span>
      </div>
      <div style={{ fontSize: "0.85rem" }}>{issue.question}</div>
      {issue.fragment && issue.fragment !== issue.question && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted, #888)", marginTop: "0.15rem" }}>
          Fragment: "{issue.fragment}"
        </div>
      )}
    </div>
  );
}

export function ClarityPanel({
  result,
  onClarify,
  onProceed,
  onRephrase,
  onSplit,
}: {
  result: ClarityResult;
  onClarify: () => void;
  onProceed: () => void;
  onRephrase: () => void;
  onSplit?: () => void;
}) {
  const [showSuggestions, setShowSuggestions] = useState(false);

  if (result.isClear) {
    return (
      <div style={{
        padding: "0.5rem 0.75rem", borderRadius: "6px",
        background: "var(--green, #4ade80)11",
        border: "1px solid var(--green, #4ade80)33",
        margin: "0.5rem 0",
      }}>
        <ScoreBar score={result.score} />
        <span style={{ fontSize: "0.85rem", color: "var(--green, #4ade80)" }}>
          ✓ Goal is clear
        </span>
      </div>
    );
  }

  const hasBroad = result.issues.some((i) => i.type === "too_broad");
  const icon = result.score < 0.5 ? "🚨" : "🔍";

  return (
    <div style={{
      background: "var(--card-bg, #1a1a2e)",
      border: `1px solid ${result.score < 0.5 ? "var(--red, #f87171)" : "var(--yellow, #facc15)"}44`,
      borderRadius: "8px",
      padding: "1rem",
      margin: "0.75rem 0",
    }}>
      <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>
        {icon} {result.score < 0.5 ? "Goal needs clarification" : "Goal could be clearer"}
      </h3>

      <ScoreBar score={result.score} />

      <div style={{ display: "grid", gap: "0.4rem", marginBottom: "0.75rem" }}>
        {result.issues.map((issue, i) => (
          <IssueCard key={`${issue.type}-${i}`} issue={issue} />
        ))}
      </div>

      {result.suggestions.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <button
            onClick={() => setShowSuggestions(!showSuggestions)}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--text-muted, #888)", fontSize: "0.8rem",
              padding: 0, textDecoration: "underline",
            }}
          >
            {showSuggestions ? "Hide" : "Show"} suggestions
          </button>
          {showSuggestions && (
            <div style={{ marginTop: "0.35rem", fontSize: "0.8rem", color: "var(--text-muted, #888)" }}>
              {result.suggestions.map((s, i) => (
                <div key={i} style={{ marginBottom: "0.2rem" }}>→ {s}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button onClick={onClarify} style={btnStyle("var(--blue, #60a5fa)")}>
          Clarify goal
        </button>
        <button onClick={onProceed} style={btnStyle("var(--green, #4ade80)")}>
          Proceed anyway
        </button>
        <button onClick={onRephrase} style={btnStyle("var(--yellow, #facc15)")}>
          Rephrase
        </button>
        {hasBroad && onSplit && (
          <button onClick={onSplit} style={btnStyle("var(--purple, #a78bfa)")}>
            Split into focused goals
          </button>
        )}
      </div>
    </div>
  );
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${color}`,
    color,
    borderRadius: "4px",
    padding: "0.35rem 0.75rem",
    cursor: "pointer",
    fontSize: "0.8rem",
  };
}
