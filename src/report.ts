/** What an agent's report says, read from its text. */

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

