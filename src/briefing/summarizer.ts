/**
 * Task summarizer — groups related completed tasks by verb+noun prefix.
 * Rule-based only, no LLM calls.
 */

/** Extract "verb noun" prefix from a task description. */
function extractPrefix(description: string): string {
  const words = description.trim().split(/\s+/);
  if (words.length < 2) return description.trim().toLowerCase();
  return `${words[0]!.toLowerCase()} ${words[1]!.toLowerCase()}`;
}

/** Convert verb to past tense for summary display. */
function pastTense(verb: string): string {
  const irregulars: Record<string, string> = {
    write: "Wrote",
    build: "Built",
    run: "Ran",
    set: "Set",
    get: "Got",
    make: "Made",
    do: "Did",
    go: "Went",
    take: "Took",
    give: "Gave",
    find: "Found",
    think: "Thought",
    tell: "Told",
    become: "Became",
    show: "Showed",
    know: "Knew",
    begin: "Began",
    keep: "Kept",
    hold: "Held",
    bring: "Brought",
    stand: "Stood",
    understand: "Understood",
  };

  const lower = verb.toLowerCase();
  if (irregulars[lower]) return irregulars[lower]!;

  // Already past tense
  if (lower.endsWith("ed")) return verb.charAt(0).toUpperCase() + verb.slice(1);

  // Regular past tense
  if (lower.endsWith("e")) return verb.charAt(0).toUpperCase() + verb.slice(1) + "d";
  if (/[bcdfghjklmnpqrstvwxyz]$/.test(lower)) {
    return verb.charAt(0).toUpperCase() + verb.slice(1) + "ed";
  }
  return verb.charAt(0).toUpperCase() + verb.slice(1) + "ed";
}

export interface GroupedTask {
  summary: string;
  count: number;
}

/**
 * Group and summarize completed task descriptions.
 * Returns at most `maxItems` grouped summaries.
 */
export function summarizeTasks(descriptions: string[], maxItems = 5): string[] {
  if (descriptions.length === 0) return [];

  // Group by verb+noun prefix
  const groups = new Map<string, string[]>();
  for (const desc of descriptions) {
    const prefix = extractPrefix(desc);
    const existing = groups.get(prefix);
    if (existing) {
      existing.push(desc);
    } else {
      groups.set(prefix, [desc]);
    }
  }

  // Build summaries
  const results: GroupedTask[] = [];
  for (const [prefix, tasks] of groups) {
    if (tasks.length === 1) {
      // Single task — convert to past tense
      const words = tasks[0]!.trim().split(/\s+/);
      const verb = words[0] ?? "";
      const rest = words.slice(1).join(" ");
      results.push({
        summary: `${pastTense(verb)} ${rest}`,
        count: 1,
      });
    } else {
      // Grouped tasks — use past tense verb + noun + count
      const prefixWords = prefix.split(/\s+/);
      const verb = prefixWords[0] ?? "";
      const noun = prefixWords.slice(1).join(" ");
      results.push({
        summary: `${pastTense(verb)} ${noun} (${tasks.length} tasks)`,
        count: tasks.length,
      });
    }
  }

  // Sort by count descending (most significant first), then trim
  results.sort((a, b) => b.count - a.count);
  return results.slice(0, maxItems).map((r) => r.summary);
}
