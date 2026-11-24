import type { Run } from "./api";
import { itemFields, toItem } from "./items";

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
  mode: "change",
  itemId: 1,
  sessionId: null,
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

test("toItem points at the runs the server named", () => {
  const item = toItem({
    id: 1,
    jobId: 1,
    state: "review",
    verdict: "implemented",
    runs: [run({ id: 1, commits: 1 }), run({ id: 2, followUpOf: 1, mode: "ask" })],
    latestWorkId: 1,
    withChangesId: 1,
    replied: false,
    canRelease: true,
  });
  expect([item.root.id, item.latest.id, item.latestWork.id, item.withChanges?.id, item.canRelease]).toEqual([1, 2, 1, 1, true]);
  expect(toItem({ ...{ id: 3, jobId: 1, state: "closed", verdict: "unknown", replied: false, canRelease: false }, runs: [run({ id: 3 })], latestWorkId: 3, withChangesId: null }).withChanges).toBeNull();
});

test("itemFields reads a report's reference and kind", () => {
  expect(itemFields(run({ payload: '{"reference": "HS-1", "kind": "problem", "received_at": "2026-11-22T00:00:00Z"}' }))).toEqual({
    reference: "HS-1",
    kind: "problem",
    receivedAt: "2026-11-22T00:00:00Z",
  });
  expect(itemFields(run({ payload: "plain" }))).toEqual({ reference: null, kind: null, receivedAt: null });
});

