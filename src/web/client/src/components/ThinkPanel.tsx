import { useState, useCallback } from "react";

interface ThinkRecommendation {
  choice: string;
  confidence: number;
  reasoning: string;
  tradeoffs: { pros: string[]; cons: string[] };
}

interface ThinkState {
  status: "idle" | "loading" | "streaming" | "done" | "error";
  sessionId: string | null;
  techLeadPerspective: string;
  rfcAuthorPerspective: string;
  recommendation: ThinkRecommendation | null;
  error: string | null;
  followUpCount: number;
}

const initial: ThinkState = {
  status: "idle",
  sessionId: null,
  techLeadPerspective: "",
  rfcAuthorPerspective: "",
  recommendation: null,
  error: null,
  followUpCount: 0,
};

export function ThinkPanel() {
  const [question, setQuestion] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [state, setState] = useState<ThinkState>(initial);
  const [saved, setSaved] = useState(false);

  const processStream = useCallback(
    async (resp: Response, isFollowUp: boolean) => {
      if (!resp.ok || !resp.body) {
        setState((s) => ({
          ...s,
          status: "error",
          error: "Request failed",
        }));
        return;
      }

      setState((s) => ({ ...s, status: "streaming" }));
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const { event, data } = JSON.parse(line.slice(6));
            setState((s) => {
              switch (event) {
                case "tech_lead_chunk":
                  return {
                    ...s,
                    techLeadPerspective:
                      s.techLeadPerspective + data.content,
                  };
                case "rfc_author_chunk":
                  return {
                    ...s,
                    rfcAuthorPerspective:
                      s.rfcAuthorPerspective + data.content,
                  };
                case "recommendation":
                  return { ...s, recommendation: data.recommendation };
                case "error":
                  return { ...s, error: data.message };
                case "done":
                  return {
                    ...s,
                    status: "done" as const,
                    sessionId: data.sessionId ?? s.sessionId,
                    followUpCount: isFollowUp
                      ? s.followUpCount + 1
                      : s.followUpCount,
                  };
                default:
                  return s;
              }
            });
          } catch {
            /* ignore parse errors */
          }
        }
      }
    },
    [],
  );

  const startThink = useCallback(async () => {
    if (!question.trim()) return;
    setState({ ...initial, status: "loading" });
    setSaved(false);

    try {
      const resp = await fetch("/api/think", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      await processStream(resp, false);
    } catch (err) {
      setState((s) => ({ ...s, status: "error", error: String(err) }));
    }
  }, [question, processStream]);

  const sendFollowUp = useCallback(async () => {
    if (!followUp.trim() || !state.sessionId || state.followUpCount >= 3)
      return;

    setState((s) => ({
      ...s,
      status: "streaming",
      techLeadPerspective: "",
      rfcAuthorPerspective: "",
      recommendation: null,
    }));

    try {
      const resp = await fetch(
        `/api/think/${state.sessionId}/followup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: followUp.trim() }),
        },
      );
      await processStream(resp, true);
      setFollowUp("");
    } catch (err) {
      setState((s) => ({ ...s, status: "error", error: String(err) }));
    }
  }, [followUp, state.sessionId, state.followUpCount, processStream]);

  const saveToJournal = useCallback(async () => {
    if (!state.sessionId) return;
    try {
      const resp = await fetch(`/api/think/${state.sessionId}/save`, {
        method: "POST",
      });
      const result = await resp.json();
      if (result.success) {
        setSaved(true);
      }
    } catch (err) {
      setState((s) => ({ ...s, error: `Save failed: ${err}` }));
    }
  }, [state.sessionId]);

  const reset = useCallback(() => {
    setState(initial);
    setQuestion("");
    setFollowUp("");
    setSaved(false);
  }, []);

  return (
    <div style={{ padding: "1rem", fontFamily: "monospace" }}>
      <h2 style={{ margin: "0 0 1rem", color: "#f5a623" }}>
        🦆 Rubber Duck Mode
      </h2>

      {state.status === "idle" && (
        <div>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startThink()}
            placeholder="What are you thinking about?"
            style={{
              width: "100%",
              padding: "0.75rem",
              fontSize: "1rem",
              background: "#1a1a2e",
              color: "#fff",
              border: "1px solid #333",
              borderRadius: "4px",
              boxSizing: "border-box",
            }}
          />
          <button
            onClick={startThink}
            disabled={!question.trim()}
            style={{
              marginTop: "0.5rem",
              padding: "0.5rem 1rem",
              background: "#f5a623",
              color: "#000",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            Think
          </button>
        </div>
      )}

      {state.status === "loading" && (
        <p style={{ color: "#888" }}>Checking past decisions...</p>
      )}

      {(state.status === "streaming" || state.status === "done") && (
        <div>
          {state.techLeadPerspective && (
            <div
              style={{
                margin: "1rem 0",
                padding: "1rem",
                background: "#1a2a1a",
                borderRadius: "4px",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem", color: "#4caf50" }}>
                Tech Lead
              </h3>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {state.techLeadPerspective}
              </p>
            </div>
          )}

          {state.rfcAuthorPerspective && (
            <div
              style={{
                margin: "1rem 0",
                padding: "1rem",
                background: "#1a1a2e",
                borderRadius: "4px",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem", color: "#2196f3" }}>
                RFC Author
              </h3>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {state.rfcAuthorPerspective}
              </p>
            </div>
          )}

          {state.recommendation && (
            <div
              style={{
                margin: "1rem 0",
                padding: "1rem",
                background: "#2a2a1a",
                borderRadius: "4px",
                border: "1px solid #f5a623",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem", color: "#f5a623" }}>
                Recommendation: {state.recommendation.choice}
              </h3>
              <p style={{ margin: "0 0 0.5rem", color: "#ccc" }}>
                Confidence: {state.recommendation.confidence.toFixed(2)}
              </p>
              <p style={{ margin: "0 0 0.5rem" }}>
                {state.recommendation.reasoning}
              </p>
              <div style={{ display: "flex", gap: "2rem" }}>
                <div>
                  {state.recommendation.tradeoffs.pros.map((p, i) => (
                    <div key={i} style={{ color: "#4caf50" }}>
                      ✓ {p}
                    </div>
                  ))}
                </div>
                <div>
                  {state.recommendation.tradeoffs.cons.map((c, i) => (
                    <div key={i} style={{ color: "#f44336" }}>
                      ✗ {c}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {state.status === "done" && (
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                marginTop: "1rem",
                flexWrap: "wrap",
              }}
            >
              {!saved ? (
                <button
                  onClick={saveToJournal}
                  style={{
                    padding: "0.5rem 1rem",
                    background: "#4caf50",
                    color: "#fff",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                >
                  Save to Journal
                </button>
              ) : (
                <span style={{ color: "#4caf50", padding: "0.5rem 1rem" }}>
                  ✓ Saved
                </span>
              )}
              {state.followUpCount < 3 && (
                <div style={{ display: "flex", gap: "0.5rem", flex: 1 }}>
                  <input
                    type="text"
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && sendFollowUp()
                    }
                    placeholder="Follow-up question..."
                    style={{
                      flex: 1,
                      padding: "0.5rem",
                      background: "#1a1a2e",
                      color: "#fff",
                      border: "1px solid #333",
                      borderRadius: "4px",
                    }}
                  />
                  <button
                    onClick={sendFollowUp}
                    disabled={!followUp.trim()}
                    style={{
                      padding: "0.5rem 1rem",
                      background: "#2196f3",
                      color: "#fff",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                    }}
                  >
                    Ask
                  </button>
                </div>
              )}
              <button
                onClick={reset}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#333",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                New Question
              </button>
            </div>
          )}
        </div>
      )}

      {state.error && (
        <p style={{ color: "#f44336", marginTop: "1rem" }}>
          Error: {state.error}
        </p>
      )}
    </div>
  );
}
