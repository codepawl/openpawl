/**
 * Shared formatters — single source of truth for token counts,
 * durations, byte sizes, and relative timestamps.
 */

/**
 * Format a token count to a compact human-readable string.
 * 0 → "0", 999 → "999", 1234 → "1.2k", 15340 → "15k", 1500000 → "1.5M"
 */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Format milliseconds to a human-readable duration.
 * 500 → "500ms", 3200 → "3.2s", 65000 → "1m 5s", 3600000 → "60m 0s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

/**
 * Format bytes to a human-readable size string.
 * 512 → "512 B", 1024 → "1.0 KB", 1048576 → "1.0 MB", 1073741824 → "1.0 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Extract the key argument from tool call args for display.
 * Prioritizes: path > command > pattern > url > first string arg.
 */
export function formatInputSummary(_toolName: string, args: Record<string, unknown>): string {
  const path = args.path ?? args.file_path;
  if (typeof path === "string") return path;
  const command = args.command;
  if (typeof command === "string") return command.length > 50 ? command.slice(0, 47) + "..." : command;
  const pattern = args.pattern ?? args.query;
  if (typeof pattern === "string") return `"${pattern.length > 40 ? pattern.slice(0, 37) + "..." : pattern}"`;
  const url = args.url;
  if (typeof url === "string") return url.length > 50 ? url.slice(0, 47) + "..." : url;
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const first = args[keys[0]!];
  if (typeof first === "string") return first.length > 50 ? first.slice(0, 47) + "..." : first;
  return JSON.stringify(args).slice(0, 50);
}

/**
 * Truncate an inputSummary for compact display.
 * Long paths → last 2 segments with "..." prefix.
 * Caps at maxLen chars.
 */
export function formatToolTarget(inputSummary: string | undefined, maxLen = 40): string {
  if (!inputSummary) return "";
  const trimmed = inputSummary.trim();
  if (trimmed.length === 0) return "";

  // For paths: keep last 2 segments if too long
  if (trimmed.includes("/") && trimmed.length > maxLen) {
    const parts = trimmed.split("/");
    const tail = parts.slice(-2).join("/");
    const result = tail.length > maxLen ? tail.slice(-maxLen + 3) : `...${tail}`;
    return result.length > maxLen ? result.slice(-maxLen) : result;
  }

  // Generic truncation
  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen - 3) + "...";
  return trimmed;
}

/**
 * Format an ISO date string to a relative time label.
 * "just now", "5m ago", "2h ago", "yesterday", "3d ago", "1w ago", "2mo ago"
 */
export function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w ago`;
  const diffMonth = Math.floor(diffDay / 30);
  return `${diffMonth}mo ago`;
}
