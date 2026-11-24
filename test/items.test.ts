import assert from "node:assert/strict";
import { test } from "node:test";
import { itemView, runView } from "../src/items.ts";
import { parseVerdict } from "../src/report.ts";
import type { Job, Run } from "../src/store.ts";

const run = (overrides: Partial<Run> & { merged?: boolean }): ReturnType<typeof runView> => {
  const { merged = false, ...fields } = overrides;
  return runView(
    {
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
      requestedBy: null,
      summary: null,
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
      ...fields,
    },
    merged,
  );
};

const releasing = { releaseInstructions: "Release it", shipCommand: null } as Job;
const script = { releaseInstructions: null, shipCommand: "scripts/release.sh" } as Job;
const state = (runs: ReturnType<typeof run>[]) => itemView(runs, null).state;

test("an item's state follows its newest work", () => {
  assert.equal(state([run({ id: 4, commits: 1, summary: "HS-1: feature idea, needs the owner's decision." }), run({ id: 5, followUpOf: 4, summary: "Implemented HS-1", commits: 1 })]), "review");
  assert.equal(state([run({ status: "awaiting_approval" })]), "approval");
  assert.equal(state([run({ id: 7, status: "failed" }), run({ id: 8, retryOf: 7, status: "queued" })]), "running");
  assert.equal(state([run({ summary: "HS-1: feature idea, needs the owner's decision." })]), "decision");
  assert.equal(state([run({ commits: 1, merged: true })]), "merged");
  assert.equal(state([run({ commits: 1, closedAt: "2026-11-22T00:00:00Z" })]), "closed");
  assert.equal(state([run({ status: "canceled" })]), "closed");
  assert.equal(state([run({ status: "timed_out" })]), "failed");
  assert.equal(state([run({ summary: "Verdict: duplicate of HS-2" })]), "closed");
  assert.equal(state([run({ commits: 0 })]), "closed");
  assert.equal(state([run({ summary: "HS-1 triaged\n- **Verdict:** needs the owner's decision", commits: 1 })]), "decision", "a triage note on a branch still waits for a decision");
});

test("questions don't change an item's verdict or state", () => {
  const item = itemView(
    [
      run({ id: 1, summary: "HS-1: feature idea, needs the owner's decision." }),
      run({ id: 2, followUpOf: 1, mode: "ask", summary: "It is fixed in two places." }),
      run({ id: 3, followUpOf: 2, mode: "ask", status: "failed" }),
    ],
    null,
  );
  assert.deepEqual([item.verdict, item.state], ["needs_decision", "decision"]);
  const closed = itemView([run({ id: 1, closedAt: "2026-11-22T00:00:00Z" }), run({ id: 2, followUpOf: 1, mode: "ask" })], null);
  assert.deepEqual([closed.state, closed.latestWorkId], ["closed", 1]);
});

test("releases: released once one succeeds; releasable with instructions or a script, changes and succeeded work", () => {
  const work = run({ id: 1, commits: 1, headCommit: "abc" });
  assert.equal(itemView([work], releasing).canRelease, true);
  assert.equal(itemView([work], script).canRelease, true);
  assert.equal(itemView([work], { releaseInstructions: null, shipCommand: null } as Job).canRelease, false);
  assert.equal(itemView([run({ commits: 0 })], releasing).canRelease, false);
  assert.equal(itemView([run({ commits: 1, status: "failed" })], releasing).canRelease, false);

  const failedRelease = run({ id: 2, followUpOf: 1, trigger: "manual", mode: "release", status: "failed" });
  const broken = itemView([work, failedRelease], releasing);
  assert.deepEqual([broken.state, broken.canRelease], ["failed", true], "a failed release can be released again");
  const released = itemView([work, failedRelease, run({ id: 3, followUpOf: 2, mode: "release" })], releasing);
  assert.deepEqual([released.state, released.withChangesId], ["released", 1]);
  assert.equal(itemView([work, run({ id: 2, followUpOf: 1, mode: "ship", status: "running" })], script).canRelease, false);
});

test("verdicts read negations as not done", () => {
  assert.equal(parseVerdict("Implemented HS-1"), "implemented");
  assert.equal(parseVerdict("Fixed on this branch"), "fixed");
  assert.equal(parseVerdict("This feature has not been implemented."), "needs_decision");
  assert.equal(parseVerdict("Verdict: could not be fixed safely"), "needs_decision");
  assert.equal(parseVerdict("Verdict: can't reproduce"), "cant_reproduce");
  assert.equal(parseVerdict("Some report\n**Verdict:** fixed on this branch"), "fixed");
});
