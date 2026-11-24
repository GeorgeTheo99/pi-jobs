import { splitReply } from "./report";

const TRIAGE = `**HS-E123817D: feature idea, needs the owner’s decision.**

- **What I found:** no reorder control.

**Suggested reply**

Thanks for the suggestion. We've recorded a proposal.`;

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
