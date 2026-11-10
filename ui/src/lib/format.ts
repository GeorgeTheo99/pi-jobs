const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "in 3 hours", "5 minutes ago", "now". */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return diff > 0 ? "in under a minute" : "just now";
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function duration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return "—";
  const seconds = Math.max(0, Math.round(((endIso ? Date.parse(endIso) : now) - Date.parse(startIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function repoName(repoPath: string): string {
  return repoPath.replace(/\/+$/, "").split("/").pop() || repoPath;
}

export const SCHEDULE_PRESETS: { label: string; expression: string }[] = [
  { label: "Hourly", expression: "0 * * * *" },
  { label: "Daily 6:00", expression: "0 6 * * *" },
  { label: "Weekdays 9:00", expression: "0 9 * * 1-5" },
  { label: "Mondays 8:00", expression: "0 8 * * 1" },
];

export function describeSchedule(expression: string | null): string {
  if (!expression) return "No schedule";
  return SCHEDULE_PRESETS.find((p) => p.expression === expression)?.label ?? expression;
}
