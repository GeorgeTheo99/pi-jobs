/** What an agent's report says, read from its text, and what a webhook or watch payload is about. */

/** A payload's title, description or first text field, for a one-line summary; null when it has none. */
export function summarizePayload(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of ["title", "summary", "subject", "description", "message", "details", "body"]) {
        const field = record[key];
        if (typeof field === "string" && field.trim()) return field.trim().split("\n")[0]!.slice(0, 120);
      }
    }
  } catch {
    // Not JSON: its first line.
  }
  return payload.trim().split("\n")[0]!.slice(0, 120) || null;
}

/** A report's "Verdict: …" line, which the triage prompt asks for, so lists can show the verdict without the report. */
export function summaryVerdict(summary: string | null): string | null {
  const line = summary?.split("\n").find((l) => /^\W*verdict\W*:/i.test(l.replace(/\*\*|__|`/g, "").trim()));
  return line ? line.trim().slice(0, 300) : null;
}

/** The first line of an agent's report, without Markdown emphasis or heading marks, for lists. */
export function summaryHeadline(summary: string | null): string | null {
  const line = summary
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[-=*_`]{3,}$/.test(l));
  if (!line) return null;
  const plain = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain || null;
}


export type Verdict = "implemented" | "fixed" | "needs_decision" | "cant_reproduce" | "duplicate" | "not_actionable" | "unknown";

/** Plain text of a Markdown line: no emphasis, code ticks, heading or list marks; curly quotes made straight. */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/[‘’]/g, "'")
    .trim();
}

/** "not implemented", "hasn't been fixed", "could not be fixed": a done-word that says it wasn't done. */
const NEGATED_DONE = /\b(not|n't|never|unable to|without being)\s+(?:\w+\s+){0,2}(implemented|fixed|resolved)\b/;

function classify(text: string): Verdict {
  const t = plainLine(text).toLowerCase();
  const negated = NEGATED_DONE.test(t);
  if (!negated && /\bimplemented\b/.test(t)) return "implemented";
  if (!negated && /\b(fixed|committed as|resolved)\b/.test(t)) return "fixed";
  if (/\b(needs?|awaiting|requires)\b.{0,20}\b(decision|owner|input|call)\b/.test(t) || /\bfeature idea\b/.test(t)) {
    return "needs_decision";
  }
  if (/\b(can't|cannot|could ?not|unable to) reproduce\b/.test(t)) return "cant_reproduce";
  if (/\bduplicate of\b|^duplicate\b/.test(t)) return "duplicate";
  if (/\bnot actionable\b/.test(t)) return "not_actionable";
  if (negated) return "needs_decision";
  return "unknown";
}

/**
 * The verdict of a report: from an explicit "Verdict:" line when there is one (the triage prompt asks
 * for it), otherwise from the first line, where agents put their headline.
 */
export function parseVerdict(summary: string | null | undefined): Verdict {
  if (!summary) return "unknown";
  const explicit = summary.split("\n").find((line) => /^\W*verdict\W*:/i.test(plainLine(line)));
  if (explicit) {
    const verdict = classify(plainLine(explicit).replace(/^\W*verdict\W*:\s*/i, ""));
    if (verdict !== "unknown") return verdict;
  }
  const first = summary.split("\n").find((line) => line.trim());
  return first ? classify(first) : "unknown";
}

/** Verdicts that mean the item's changes are the work it asked for, so it can be released without the owner. */
export const RELEASABLE_VERDICTS: readonly Verdict[] = ["implemented", "fixed"];
