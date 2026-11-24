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

/** Keys whose string value best says what a webhook or watch item is about, in order of preference. */
const HEADLINE_KEYS = ["title", "subject", "summary", "description", "message", "name", "text"];
const MAX_HEADLINE = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export interface PayloadSummary {
  /** One line saying what the item is about, if the payload has one. */
  headline: string | null;
  /** The payload's top-level plain values, labeled for people; nested values stay in the raw payload. */
  fields: { label: string; value: string }[];
}

/** Makes a run's payload readable: a JSON object's headline and fields, or the first line of other text. */
export function summarizePayload(payload: string | null): PayloadSummary {
  if (!payload?.trim()) return { headline: null, fields: [] };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { headline: clip(payload.trim().split("\n")[0]), fields: [] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { headline: null, fields: [] };
  const entries = Object.entries(value as Record<string, unknown>);
  const headlineKey = HEADLINE_KEYS.find((key) => entries.some(([k, v]) => k.toLowerCase() === key && typeof v === "string" && v.trim()));
  let headline: string | null = null;
  const fields: PayloadSummary["fields"] = [];
  for (const [key, raw] of entries) {
    if (headline === null && key.toLowerCase() === headlineKey) {
      headline = clip((raw as string).trim());
      continue;
    }
    if (typeof raw === "string" && raw.trim()) {
      fields.push({ label: humanize(key), value: ISO_DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? dateTime(raw) : raw });
    } else if (typeof raw === "number") {
      fields.push({ label: humanize(key), value: String(raw) });
    } else if (typeof raw === "boolean") {
      fields.push({ label: humanize(key), value: raw ? "Yes" : "No" });
    }
  }
  return { headline, fields };
}

function clip(text: string): string {
  return text.length > MAX_HEADLINE ? `${text.slice(0, MAX_HEADLINE - 1)}…` : text;
}

/** "received_at", "receivedAt" and "received-at" all become "Received at". */
function humanize(key: string): string {
  const words = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/** A setting's value on a chat action's card, exactly as it would be saved. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(none)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
