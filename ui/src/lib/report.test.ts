import { parseVerdict, splitReply } from "./report";

const TRIAGE = `**HS-E123817D: feature idea, needs the owner’s decision.**

- **What I found:** no reorder control.

**Suggested reply**

Thanks for the suggestion. We've recorded a proposal.`;

const IMPLEMENTED = "**Implemented HS-E123817D and committed as `1f87d08`** — `feat: add household scene reordering`.\n\n- Added Reorder.";

test("parseVerdict reads the headline of real reports", () => {
  expect(parseVerdict(TRIAGE)).toBe("needs_decision");
  expect(parseVerdict(IMPLEMENTED)).toBe("implemented");
  expect(parseVerdict("**MY-1: problem, fixed on this branch.**")).toBe("fixed");
  expect(parseVerdict("Done.\n- Verdict: can't reproduce")).toBe("cant_reproduce");
  expect(parseVerdict("Summary\nVerdict: duplicate of MY-12")).toBe("duplicate");
  expect(parseVerdict("**Verdict:** not actionable")).toBe("not_actionable");
  expect(parseVerdict("Wrote the report.")).toBe("unknown");
  expect(parseVerdict("")).toBe("unknown");
  expect(parseVerdict(null)).toBe("unknown");
});

test("splitReply separates the suggested reply from the findings", () => {
  const { report, reply } = splitReply(TRIAGE);
  expect(reply).toBe("Thanks for the suggestion. We've recorded a proposal.");
  expect(report).not.toMatch(/Suggested reply/);
  expect(report).toMatch(/What I found/);

  expect(splitReply('## Suggested reply\n> "Thanks!"\n\n## Notes\nx')).toEqual({ report: "## Notes\nx", reply: "Thanks!" });
  expect(splitReply("- Suggested reply to the reporter: Thanks, fixed in the next release.").reply).toBe(
    "Thanks, fixed in the next release.",
  );
  expect(splitReply("No reply here")).toEqual({ report: "No reply here", reply: null });
});
