import { useState, useEffect, useCallback } from "react";

interface CommunicationStyle {
  tone: string;
  verbosity: string;
  usesQuestions: boolean;
  pushbackStyle: string;
}

interface AgentOpinion {
  topic: string;
  stance: string;
  strength: string;
}

interface PushbackTrigger {
  pattern: string;
  response: string;
  severity: string;
}

interface AgentPersonality {
  role: string;
  traits: string[];
  communicationStyle: CommunicationStyle;
  opinions: AgentOpinion[];
  pushbackTriggers: PushbackTrigger[];
  catchphrases: string[];
}

interface PersonalityEvent {
  id: string;
  agentRole: string;
  eventType: string;
  sessionId: string;
  content: string;
  relatedTaskId?: string;
  createdAt: number;
}

interface PersonalityConfig {
  enabled: boolean;
  pushbackEnabled: boolean;
  coordinatorIntervention: boolean;
  agentOverrides: Record<string, { enabled?: boolean }>;
}

const SEVERITY_COLORS: Record<string, string> = {
  block: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  note: "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400",
};

const TRAIT_COLORS: Record<string, string> = {
  pragmatic: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  thorough: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  decisive: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  skeptical: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  forward_thinking: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  quality_focused: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  efficiency_oriented: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
};

function TraitBadge({ trait }: { trait: string }) {
  const color = TRAIT_COLORS[trait] ?? "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {trait.replace(/_/g, " ")}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const color = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.note;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {severity}
    </span>
  );
}

function ProfileCard({ personality }: { personality: AgentPersonality }) {
  const [expanded, setExpanded] = useState(false);
  const style = personality.communicationStyle;

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 shadow-sm">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div>
          <h4 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
            <i className="bi bi-person-fill mr-1.5" />
            {personality.role}
          </h4>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            {style.tone} &middot; {style.verbosity} &middot; {style.pushbackStyle} pushback
          </p>
        </div>
        <i className={`bi ${expanded ? "bi-chevron-up" : "bi-chevron-down"} text-stone-400`} />
      </button>

      <div className="mt-2 flex flex-wrap gap-1">
        {personality.traits.map((t) => <TraitBadge key={t} trait={t} />)}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 animate-fade-in">
          {personality.opinions.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-stone-600 dark:text-stone-300 mb-1">Opinions</h5>
              <ul className="space-y-1">
                {personality.opinions.map((o) => (
                  <li key={o.topic} className="text-xs text-stone-700 dark:text-stone-300">
                    <span className="font-medium">{o.topic}:</span> {o.stance}
                    <span className="ml-1 text-stone-400">({o.strength})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {personality.pushbackTriggers.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-stone-600 dark:text-stone-300 mb-1">Pushback Triggers</h5>
              <ul className="space-y-1">
                {personality.pushbackTriggers.map((t) => (
                  <li key={t.pattern} className="flex items-start gap-1.5 text-xs">
                    <SeverityBadge severity={t.severity} />
                    <span className="text-stone-700 dark:text-stone-300">
                      <code className="rounded bg-stone-100 dark:bg-stone-800 px-1 py-0.5 font-mono text-xs">{t.pattern}</code>
                      {" "}&rarr; {t.response}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {personality.catchphrases.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-stone-600 dark:text-stone-300 mb-1">Catchphrases</h5>
              <ul className="space-y-0.5">
                {personality.catchphrases.map((c) => (
                  <li key={c} className="text-xs italic text-stone-600 dark:text-stone-400">
                    &ldquo;{c}&rdquo;
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PersonalityPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [profiles, setProfiles] = useState<Record<string, AgentPersonality>>({});
  const [events, setEvents] = useState<PersonalityEvent[]>([]);
  const [config, setConfig] = useState<PersonalityConfig | null>(null);
  const [tab, setTab] = useState<"profiles" | "events">("profiles");

  const fetchData = useCallback(async () => {
    try {
      const [profilesRes, eventsRes, configRes] = await Promise.all([
        fetch("/api/personality/profiles").then((r) => r.json()),
        fetch("/api/personality/events").then((r) => r.json()),
        fetch("/api/personality/config").then((r) => r.json()),
      ]);
      setProfiles(profilesRes.profiles ?? {});
      setEvents(eventsRes.events ?? []);
      setConfig(configRes.config ?? null);
    } catch {
      // API unavailable
    }
  }, []);

  useEffect(() => {
    if (open) fetchData();
  }, [open, fetchData]);

  if (!open) return null;

  const profileList = Object.values(profiles);

  return (
    <>
      <div className="fixed inset-0 z-20 bg-black/20 animate-fade-in" onClick={onClose} />
      <div className="fixed right-4 top-16 z-30 w-[420px] max-h-[80vh] rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl animate-drop-in flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-stone-200 dark:border-stone-700 px-4 py-3">
          <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
            <i className="bi bi-people-fill mr-1.5" />Agent Personalities
          </h3>
          <div className="flex items-center gap-2">
            {config && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                config.enabled
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                  : "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400"
              }`}>
                {config.enabled ? "Enabled" : "Disabled"}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
            >
              <i className="bi bi-x-lg" />
            </button>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-stone-200 dark:border-stone-700">
          <button
            type="button"
            onClick={() => setTab("profiles")}
            className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
              tab === "profiles"
                ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
            }`}
          >
            <i className="bi bi-person-badge mr-1" />Profiles ({profileList.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("events")}
            className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
              tab === "events"
                ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
            }`}
          >
            <i className="bi bi-activity mr-1" />Events ({events.length})
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {tab === "profiles" && (
            <>
              {profileList.length === 0 ? (
                <p className="py-4 text-center text-xs text-stone-400 dark:text-stone-500">No personality profiles defined.</p>
              ) : (
                profileList.map((p) => <ProfileCard key={p.role} personality={p} />)
              )}
            </>
          )}

          {tab === "events" && (
            <>
              {events.length === 0 ? (
                <p className="py-4 text-center text-xs text-stone-400 dark:text-stone-500">No personality events recorded.</p>
              ) : (
                <div className="space-y-1.5">
                  {events.map((evt) => (
                    <div
                      key={evt.id}
                      className="rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 p-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-stone-800 dark:text-stone-100">{evt.agentRole}</span>
                          <span className="rounded-full bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-300">
                            {evt.eventType}
                          </span>
                        </div>
                        <span className="text-stone-400 dark:text-stone-500">
                          {new Date(evt.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-stone-700 dark:text-stone-300">{evt.content}</p>
                      {evt.relatedTaskId && (
                        <p className="mt-0.5 text-stone-400 dark:text-stone-500">
                          Task: {evt.relatedTaskId}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
