import { ACTIVE_STATUSES, RELEASE_MODES, type Job, type Run } from "./store.ts";
import { RELEASABLE_VERDICTS, explicitVerdict, parseVerdict, summaryHeadline, summaryVerdict, type Verdict } from "./report.ts";

/**
 * Why a run that succeeded with changes isn't released automatically, or null when it is: its check
 * must have passed, and its report's "Verdict:" line must say implemented or fixed. A headline alone
 * isn't enough: the agent wrote it, after reading untrusted reports.
 */
export function autoReleaseBlocker(job: Pick<Job, "checkCommand">, run: Pick<Run, "checkStatus" | "summary">): string | null {
  if (!job.checkCommand || run.checkStatus !== "passed") return "its check didn't pass";
  const verdict = explicitVerdict(run.summary);
  if (verdict === null) return "its report has no Verdict: line";
  if (!RELEASABLE_VERDICTS.includes(verdict)) return `its report's verdict is ${verdict.replace("_", " ")}`;
  return null;
}

/**
 * An item is one piece of work: a run started by a trigger, with its retries, follow-ups and releases
 * (a support report's triage, the run that implements it, and its release). Its state says what it
 * needs next.
 */
export type ItemState = "approval" | "running" | "decision" | "review" | "staged" | "failed" | "released" | "merged" | "closed";

/** States that wait on the owner: they head the Inbox and count in its badge. */
export const WAITING_STATES: readonly ItemState[] = ["approval", "decision", "review", "staged", "failed"];

/** A run as the API shows it: with its report's headline, verdict line and verdict, and whether it is merged. */
export type RunView = Run & { summaryHeadline: string | null; summaryVerdict: string | null; verdict: Verdict; merged: boolean };

export function runView(run: Run, merged: boolean): RunView {
  return {
    ...run,
    summaryHeadline: summaryHeadline(run.summary),
    summaryVerdict: summaryVerdict(run.summary),
    // A command prints output, not a verdict.
    verdict: run.mode === "command" ? "unknown" : parseVerdict(run.summary),
    merged,
  };
}

/** A run for lists: the report itself left out (its headline, verdict line and verdict stay). */
export function listRunView(run: Run, merged: boolean): Omit<RunView, "summary"> {
  const { summary: _summary, ...view } = runView(run, merged);
  return view;
}

/** The commit a release of the item would release (as the runner finds it), from its runs, oldest first. */
export function itemHeadCommit(runs: Pick<Run, "mode" | "headCommit" | "commits">[]): string | null {
  for (const run of [...runs].reverse()) {
    if (run.mode === "release" && run.headCommit) return run.headCommit;
    if (run.headCommit && (run.commits ?? 0) > 0) return run.headCommit;
  }
  return null;
}

/**
 * The staging release an item can promote, from its runs (oldest first): its newest work is that
 * succeeded staging release, or promotions of it that didn't succeed. Null otherwise: new work, a
 * newer staging attempt or a promotion that went out ends it.
 */
export function promotableStage<R extends Pick<Run, "mode" | "stage" | "status">>(runs: R[]): R | null {
  for (const run of runs.filter((r) => r.mode !== "ask").reverse()) {
    if (run.stage === "production" && run.status !== "succeeded") continue;
    return run.stage === "staging" && run.status === "succeeded" ? run : null;
  }
  return null;
}

export interface ItemView<R extends Omit<RunView, "summary">> {
  /** The id of its first run. */
  id: number;
  jobId: number;
  state: ItemState;
  /** What its newest finished work concluded. */
  verdict: Verdict;
  /** Oldest first. */
  runs: R[];
  /** The newest run that isn't a question: what closing, reopening and releasing act on. */
  latestWorkId: number;
  /** The newest run that left commits on a branch, or null. */
  withChangesId: number | null;
  replied: boolean;
  /** Approve & release can start now. */
  canRelease: boolean;
  /** Approve & promote can start now: the job promotes and the item's staging release can go to production. */
  canPromote: boolean;
}

const isOpen = (run: Pick<Run, "status">) => ACTIVE_STATUSES.includes(run.status);

/** An item from its runs (oldest first) and its job. */
export function itemView<R extends Omit<RunView, "summary">>(runs: R[], job: Job | null): ItemView<R> {
  const latest = runs.at(-1)!;
  // Questions answer; they don't change what the item came to, so its verdict and state skip them.
  const work = runs.filter((run) => run.mode !== "ask");
  const latestWork = work.at(-1) ?? latest;
  // The verdict is what the work concluded; a release's report says how the release went.
  const finished = [...work].reverse().find((run) => !isOpen(run) && !RELEASE_MODES.includes(run.mode)) ?? null;
  const withChanges = [...runs].reverse().find((run) => (run.commits ?? 0) > 0) ?? null;
  const verdict = finished?.verdict ?? "unknown";
  const releasable = Boolean(job?.releaseInstructions || job?.shipCommand);
  return {
    id: runs[0]!.itemId,
    jobId: runs[0]!.jobId,
    state: stateOf(runs, latestWork, verdict, withChanges),
    verdict,
    runs,
    latestWorkId: latestWork.id,
    withChangesId: withChanges?.id ?? null,
    replied: runs.some((run) => run.repliedAt !== null),
    // Work that succeeded, or a release that failed (to try again); a release that went out is done until
    // new work. A staged item can go to staging again (it may have been replaced there).
    canRelease:
      releasable &&
      !runs.some(isOpen) &&
      withChanges !== null &&
      (RELEASE_MODES.includes(latestWork.mode) ? latestWork.status !== "succeeded" || latestWork.stage === "staging" : latestWork.status === "succeeded"),
    canPromote: Boolean(job?.promoteInstructions) && !runs.some(isOpen) && promotableStage(runs) !== null,
  };
}

type ListedRun = Omit<RunView, "summary">;

function stateOf(runs: ListedRun[], latestWork: ListedRun, verdict: Verdict, withChanges: ListedRun | null): ItemState {
  if (runs.some((run) => run.status === "awaiting_approval")) return "approval";
  if (runs.some(isOpen)) return "running";
  // A promotion canceled before it started leaves the item on staging.
  if (latestWork.stage === "production" && latestWork.status === "canceled" && promotableStage(runs)) return "staged";
  if (RELEASE_MODES.includes(latestWork.mode) && latestWork.status === "succeeded") return latestWork.stage === "staging" ? "staged" : "released";
  // A release that failed after it pushed (its verify command, a timeout) still needs the owner.
  if (RELEASE_MODES.includes(latestWork.mode) && latestWork.status !== "canceled") return "failed";
  if (withChanges?.merged) return "merged";
  if (latestWork.closedAt !== null) return "closed";
  if (latestWork.status === "failed" || latestWork.status === "timed_out") return "failed";
  if (latestWork.status === "canceled") return "closed";
  if (verdict === "needs_decision") return "decision";
  if (verdict === "cant_reproduce" || verdict === "duplicate" || verdict === "not_actionable") return "closed";
  if (withChanges) return "review";
  return "closed";
}
