import assert from "node:assert/strict";
import { test } from "node:test";
import { autoReleaseBlocker, itemView, runView } from "../src/items.ts";
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
  assert.deepEqual([released.state, released.withChangesId, released.canRelease], ["released", 1, false], "done until new work");
  assert.equal(itemView([work, run({ id: 2, followUpOf: 1, mode: "ship", status: "running" })], script).canRelease, false);
  // A release that pushed, then failed its verify command: on main, but still the owner's to check.
  const pushedThenFailed = itemView([run({ id: 1, commits: 1, merged: true }), run({ id: 2, followUpOf: 1, mode: "release", status: "failed" })], releasing);
  assert.equal(pushedThenFailed.state, "failed");
});

test("a command run's output is never read as an agent's verdict", () => {
  const item = itemView([run({ id: 9, mode: "command", agent: "command", summary: "Needs your decision: disk almost full" })], null);
  assert.deepEqual([item.verdict, item.state], ["unknown", "closed"]);
});

test("verdicts read negations as not done, and real report headlines", () => {
  assert.equal(parseVerdict("**HS-E123817D: feature idea, needs the owner’s decision.**\n\n- found it"), "needs_decision");
  assert.equal(parseVerdict("**Implemented HS-E123817D and committed as `1f87d08`** — `feat: add reordering`."), "implemented");
  assert.equal(parseVerdict("Done.\n- Verdict: can't reproduce"), "cant_reproduce");
  assert.equal(parseVerdict("Summary\nVerdict: duplicate of MY-12"), "duplicate");
  assert.equal(parseVerdict("**Verdict:** not actionable"), "not_actionable");
  assert.equal(parseVerdict("Wrote the report."), "unknown");
  assert.equal(parseVerdict(null), "unknown");
  assert.equal(parseVerdict("Implemented HS-1"), "implemented");
  assert.equal(parseVerdict("Fixed on this branch"), "fixed");
  assert.equal(parseVerdict("This feature has not been implemented."), "needs_decision");
  assert.equal(parseVerdict("Verdict: could not be fixed safely"), "needs_decision");
  assert.equal(parseVerdict("Verdict: can't reproduce"), "cant_reproduce");
  assert.equal(parseVerdict("Some report\n**Verdict:** fixed on this branch"), "fixed");
  assert.equal(parseVerdict("It wasn't fixed: the cause is upstream"), "needs_decision");
  assert.equal(parseVerdict("This hasn't been implemented yet"), "needs_decision");
  assert.equal(parseVerdict("Triage note committed as abc123; needs your decision"), "needs_decision");
  assert.equal(parseVerdict("A bug in the fixed-width parser"), "unknown");
});

test("automatic releases go by the check and the report's Verdict: line only", () => {
  const job = { checkCommand: "npm test" };
  assert.equal(autoReleaseBlocker(job, { checkStatus: "passed", summary: "Implemented it\nVerdict: implemented on this branch" }), null);
  assert.equal(autoReleaseBlocker(job, { checkStatus: "passed", summary: "Implemented it" }), "its report has no Verdict: line");
  assert.equal(autoReleaseBlocker(job, { checkStatus: "failed", summary: "Verdict: fixed" }), "its check didn't pass");
  assert.equal(autoReleaseBlocker({ checkCommand: null }, { checkStatus: null, summary: "Verdict: fixed" }), "its check didn't pass");
  assert.equal(autoReleaseBlocker(job, { checkStatus: "passed", summary: "Verdict: wasn't fixed" }), "its report's verdict is needs decision");
});
