import { useState } from "react";

const inputClass = "w-full rounded-lg border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-3 py-2 text-sm text-stone-800 dark:text-stone-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150 placeholder:text-stone-400 dark:placeholder:text-stone-500";

interface WebhookSettingsProps {
  webhookOnTaskComplete: string;
  webhookOnCycleEnd: string;
  webhookSecret: string;
  onChange: (field: string, value: string) => void;
}

export function WebhookSettings({
  webhookOnTaskComplete,
  webhookOnCycleEnd,
  webhookSecret,
  onChange,
}: WebhookSettingsProps) {
  const [showSecret, setShowSecret] = useState(false);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300">Webhooks</h3>

      <div>
        <label htmlFor="wh-task" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
          Task Complete URL
        </label>
        <input
          id="wh-task"
          type="text"
          value={webhookOnTaskComplete}
          onChange={(e) => onChange("webhookOnTaskComplete", e.target.value)}
          placeholder="https://hooks.example.com/task-complete"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="wh-cycle" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
          Cycle End URL
        </label>
        <input
          id="wh-cycle"
          type="text"
          value={webhookOnCycleEnd}
          onChange={(e) => onChange("webhookOnCycleEnd", e.target.value)}
          placeholder="https://hooks.example.com/cycle-end"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="wh-secret" className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
          Webhook Secret
        </label>
        <div className="relative">
          <input
            id="wh-secret"
            type={showSecret ? "text" : "password"}
            value={webhookSecret}
            onChange={(e) => onChange("webhookSecret", e.target.value)}
            placeholder="Optional signing secret"
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => setShowSecret(!showSecret)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
          >
            {showSecret ? "Hide" : "Show"}
          </button>
        </div>
        <p className="mt-1 text-xs text-stone-400">Sent as X-Webhook-Signature header.</p>
      </div>
    </div>
  );
}
