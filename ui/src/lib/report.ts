/** Reads the parts of an agent's final report the UI acts on: its verdict and its suggested reply. */

export type Verdict = "implemented" | "fixed" | "needs_decision" | "cant_reproduce" | "duplicate" | "not_actionable" | "unknown";

export const VERDICT_LABELS: Record<Verdict, string> = {
  implemented: "Implemented",
  fixed: "Fixed on branch",
  needs_decision: "Needs your decision",
  cant_reproduce: "Can't reproduce",
  duplicate: "Duplicate",
  not_actionable: "Not actionable",
  unknown: "Finished",
};

/** Plain text of a Markdown line: no emphasis, code ticks, heading or list marks; curly quotes made straight. */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/[‘’]/g, "'")
    .trim();
}

function classify(text: string): Verdict {
  const t = plainLine(text).toLowerCase();
  if (/\bimplemented\b/.test(t)) return "implemented";
  if (/\b(fixed|committed as|resolved)\b/.test(t)) return "fixed";
  if (/\b(needs?|awaiting|requires)\b.{0,20}\b(decision|owner|input|call)\b/.test(t) || /\bfeature idea\b/.test(t)) {
    return "needs_decision";
  }
  if (/\b(can't|cannot|could ?not|unable to) reproduce\b/.test(t)) return "cant_reproduce";
  if (/\bduplicate of\b|^duplicate\b/.test(t)) return "duplicate";
  if (/\bnot actionable\b/.test(t)) return "not_actionable";
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

const REPLY_HEADING = /^\s*(?:#{1,6}\s*|\*\*|__)?\s*(?:a\s+)?suggested reply\b[^\n]*$/i;
const NEXT_HEADING = /^\s*(#{1,6}\s|(\*\*|__)[^*_]+(\*\*|__)\s*:?\s*$)/;

/**
 * Splits a report into the findings and the suggested reply to the reporter. The reply is the text
 * under a "Suggested reply" heading (or after "Suggested reply:" on the same line) up to the next heading.
 */
export function splitReply(summary: string): { report: string; reply: string | null } {
  const lines = summary.split("\n");
  const start = lines.findIndex((line) => REPLY_HEADING.test(line) || /^\W*suggested reply[^:]*:\s*\S/i.test(plainLine(line)));
  if (start === -1) return { report: summary.trim(), reply: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_HEADING.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const sameLine = plainLine(lines[start]!).replace(/^\W*suggested reply[^:]*:?\s*/i, "");
  const reply = [sameLine, ...lines.slice(start + 1, end)]
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join("\n")
    .trim()
    .replace(/^["“](.*)["”]$/s, "$1")
    .trim();
  const report = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
  return { report, reply: reply || null };
}
