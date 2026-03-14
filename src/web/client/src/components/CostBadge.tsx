import { useWsStore } from "../ws";

export function CostBadge() {
  const { totalInputTokens, totalOutputTokens, totalCachedInputTokens, model } = useWsStore(
    (s) => s.tokenUsage
  );

  const total = totalInputTokens + totalOutputTokens;
  if (total === 0) return null;

  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-xs font-medium text-stone-600 dark:text-stone-300"
      title={`In: ${totalInputTokens} (cached: ${totalCachedInputTokens}) | Out: ${totalOutputTokens} | Model: ${model}`}
    >
      <i className="bi bi-cpu text-xs" />
      <span>{fmt(totalInputTokens)} in</span>
      <span className="text-stone-400 dark:text-stone-500">/</span>
      <span>{fmt(totalOutputTokens)} out</span>
    </span>
  );
}
