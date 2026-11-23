import type { Run } from "./api";
import { groupItems, itemFields } from "./items";

const run = (overrides: Partial<Run>): Run => ({
  id: 1,
  jobId: 1,
  trigger: "watch",
  status: "succeeded",
  agent: "pi",
  payload: null,
  attempt: 1,
  retryOf: null,
  notBefore: null,
  followUpOf: null,
  instructions: null,
  repliedAt: null,
  closedAt: null,
  branch: null,
  worktree: null,
  baseCommit: null,
  headCommit: null,
  commits: 0,
  exitCode: 0,
  checkStatus: null,
  pushedTo: null,
  error: null,
  createdAt: "2026-11-22T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

test("follow-ups and retries join their item; state follows the newest run", () => {
  const items = groupItems([
    run({ id: 5, followUpOf: 4, trigger: "manual", commits: 1, summaryHeadline: "Implemented HS-1" }),
    run({ id: 4, commits: 1, summaryHeadline: "HS-1: feature idea, needs the owner's decision." }),
    run({ id: 6, status: "awaiting_approval" }),
    run({ id: 7, status: "failed" }),
    run({ id: 8, retryOf: 7, status: "queued" }),
  ]);
  expect(items.map((i) => [i.root.id, i.runs.map((r) => r.id), i.state])).toEqual([
    [7, [7, 8], "running"],
    [6, [6], "approval"],
    [4, [4, 5], "review"],
  ]);
  expect(items[2]!.verdict).toBe("implemented");
});

test("item states: decision, merged, closed, failed", () => {
  const state = (runs: Run[]) => groupItems(runs)[0]!.state;
  expect(state([run({ summaryHeadline: "HS-1: feature idea, needs the owner's decision." })])).toBe("decision");
  expect(state([run({ commits: 1, merged: true })])).toBe("merged");
  expect(state([run({ commits: 1, closedAt: "2026-11-22T00:00:00Z" })])).toBe("closed");
  expect(state([run({ status: "canceled" })])).toBe("closed");
  expect(state([run({ status: "timed_out" })])).toBe("failed");
  expect(state([run({ summaryHeadline: "Verdict: duplicate of HS-2" })])).toBe("closed");
  expect(state([run({ commits: 0 })])).toBe("closed");
  expect(state([run({ summaryHeadline: "HS-1 triaged", summaryVerdict: "- **Verdict:** needs the owner's decision" })])).toBe(
    "decision",
  );
});

test("itemFields reads a report's reference and kind", () => {
  expect(itemFields(run({ payload: '{"reference": "HS-1", "kind": "problem", "received_at": "2026-11-22T00:00:00Z"}' }))).toEqual({
    reference: "HS-1",
    kind: "problem",
    receivedAt: "2026-11-22T00:00:00Z",
  });
  expect(itemFields(run({ payload: "plain" }))).toEqual({ reference: null, kind: null, receivedAt: null });
});
