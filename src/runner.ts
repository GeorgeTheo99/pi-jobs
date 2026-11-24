import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { readFile, rm, rmdir } from "node:fs/promises";
import { buildArgv, supportsSessions, withSession } from "./agents.ts";
import { RepoState } from "./changes.ts";
import { NETWORK_TIMEOUT_MS, REMOTE, baseBranch, git, isFetchableBranch, resolvesToCommit } from "./git.ts";
import { runInGroup, terminate, withoutSessionEnv, type ProcessHandle } from "./process.ts";
import { agentOutput, buildPrompt, releaseOutcome, type PreviousRun } from "./prompt.ts";
import { RELEASABLE_VERDICTS, parseVerdict } from "./report.ts";
import { ACTIVE_STATUSES, INTERRUPTED, RELEASE_MODES, WAITING_STATUSES, type Job, type Run, type RunMode, type RunStatus, type Store, type Trigger } from "./store.ts";
import { parseWatchOutput, runWatchCommand, type WatchResult } from "./watch.ts";

/** Webhook bursts beyond this many queued runs per job are rejected. */
export const MAX_QUEUED_PER_JOB = 20;
/** How much of the earlier run's output a follow-up's prompt carries. */
const MAX_PREVIOUS_OUTPUT = 12_000;
/** How much of the agent's output a run keeps as its summary (the end, where agents report). */
const MAX_SUMMARY = 20_000;
/** The wait before the first retry; each further retry waits 4x longer. */
const RETRY_DELAY_MS = 60_000;

type StopReason = "canceled" | "timed_out" | "interrupted";

interface ActiveRun extends ProcessHandle {
  jobId: number;
  /** Random per-run marker inherited by every process the run starts, unique across server instances. */
  token: string;
  stopReason: StopReason | null;
  stop(reason: StopReason): void;
}

export class QueueFullError extends Error {}
export class JobPausedError extends Error {}
/** Why an item can't be released now. */
export class ReleaseRefusedError extends Error {}
/** A run's agent is no longer in Settings: retrying can't help. */
class AgentMissingError extends Error {}

export type TriggerResult = { run: Run } | { skipped: string };

export type FireResult = TriggerResult | { watch: Promise<WatchResult> };

export interface RunnerOptions {
  store: Store;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  retryDelayMs?: number;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "job"
  );
}

export interface RunnerEvents {
  /** A run finished; `retrying` when a retry of it is queued. */
  finished: [run: Run, info: { retrying: boolean }];
  /** A run from the schedule, webhook or watch waits for the owner's approval. */
  awaiting: [run: Run];
  /** A job's watch command started failing (it had worked, or not run, before). */
  watchFailed: [job: Job, error: string];
}

export class Runner extends EventEmitter<RunnerEvents> {
  private readonly store: Store;
  private readonly env: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;
  private readonly retryDelayMs: number;
  private readonly active = new Map<number, ActiveRun>();
  private readonly executions = new Set<Promise<void>>();
  private stopping = false;
  /** Pumps again when the earliest waiting retry comes due. */
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Jobs whose watch command is running, so checks of one job never overlap. */
  private readonly watching = new Map<number, Promise<WatchResult>>();
  readonly logDir: string;
  readonly worktreeDir: string;
  /** What runs changed and which are merged, from git. */
  readonly repos: RepoState;

  constructor(options: RunnerOptions) {
    super();
    this.store = options.store;
    this.env = withoutSessionEnv(options.env ?? process.env);
    this.repos = new RepoState(this.store);
    this.killGraceMs = options.killGraceMs ?? 10_000;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.logDir = path.join(options.stateDir, "runs");
    this.worktreeDir = path.join(options.stateDir, "worktrees");
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(this.worktreeDir, { recursive: true });
  }

  logPath(runId: number): string {
    return path.join(this.logDir, `${runId}.log`);
  }

  /** Queues a run. `pump: false` leaves starting it to the caller, e.g. after its transaction commits. */
  trigger(job: Job, trigger: Trigger, payload: string | null = null, { pump = true } = {}): TriggerResult {
    if (trigger === "schedule" && this.store.countRuns(job.id, ACTIVE_STATUSES) > 0) {
      return { skipped: "a run of this job is already queued or running" };
    }
    if (this.store.countRuns(job.id, WAITING_STATUSES) >= MAX_QUEUED_PER_JOB) {
      throw new QueueFullError(`Job already has ${MAX_QUEUED_PER_JOB} runs waiting to start`);
    }
    const agent = job.agent ?? this.store.getSettings().defaultAgent;
    const approval = job.approveRuns && trigger !== "manual";
    const run = this.store.createRun(job.id, trigger, agent, payload, approval ? "awaiting_approval" : "queued");
    this.note(run.id, `${approval ? "Waiting for approval" : "Queued"} (trigger: ${trigger}, agent: ${agent})`);
    if (approval) this.emit("awaiting", run);
    if (pump) this.pump();
    return { run: this.store.getRun(run.id)! };
  }

  /**
   * A cron fire. A missed one (slept through, or due while the server was down) runs only if the
   * job catches up. A job with a watch command checks it instead of starting a run.
   */
  fireSchedule(job: Job, missed: boolean): FireResult {
    this.store.markFired(job.id);
    if (missed && !job.catchUp) return { skipped: "its time was missed and catch-up is off" };
    if (job.watchCommand) return { watch: this.watch(job) };
    return this.trigger(job, "schedule");
  }

  /**
   * Queues a run that continues a finished run with new instructions, from that run's result. It is
   * started by a person, like Run now, so it needs no approval and runs while the job is paused.
   */
  followUp(previous: Run, instructions: string, mode: RunMode = "change"): Run {
    if (this.store.countRuns(previous.jobId, WAITING_STATUSES) >= MAX_QUEUED_PER_JOB) {
      throw new QueueFullError(`Job already has ${MAX_QUEUED_PER_JOB} runs waiting to start`);
    }
    const job = this.store.getJob(previous.jobId);
    const agent = job?.agent ?? this.store.getSettings().defaultAgent;
    const run = this.store.createFollowUp(previous, agent, instructions, mode);
    this.note(run.id, `Queued (${mode === "ask" ? "question" : "follow-up"} on run #${previous.id}, agent: ${agent})`);
    this.pump();
    return this.store.getRun(run.id)!;
  }

  /**
   * Queues a release of the item's newest result: the job's release instructions for its agent, or
   * its ship command. The owner starts it (or the job's autoRelease), so it needs no approval and runs
   * while the job is paused, but only once the item's work has succeeded (or an earlier release of it
   * finished) and nothing in the item is still running.
   */
  async release(of: Run, { auto = false, expectedHead, requestedBy }: { auto?: boolean; expectedHead?: string; requestedBy?: string } = {}): Promise<Run> {
    const job = this.store.getJob(of.jobId);
    if (!job?.releaseInstructions && !job?.shipCommand) throw new ReleaseRefusedError("This job has no release instructions or ship command");
    const runs = this.store.itemRuns(of.itemId);
    if (runs.some((run) => ACTIVE_STATUSES.includes(run.status))) throw new ReleaseRefusedError("Wait for the item's runs to finish");
    const work = runs.filter((run) => run.mode !== "ask").at(-1);
    if (!work || (work.status !== "succeeded" && !RELEASE_MODES.includes(work.mode))) {
      throw new ReleaseRefusedError("Only a succeeded result can be released: follow up until a run succeeds");
    }
    const latest = runs.at(-1)!;
    const head = await this.itemHead(job, latest).catch((error: Error) => {
      throw new ReleaseRefusedError(error.message);
    });
    if (!head) throw new ReleaseRefusedError("Nothing to release: this item has no changes");
    // The owner approved what they reviewed: a follow-up that landed since must be reviewed too.
    if (expectedHead && head.commit !== expectedHead) {
      throw new ReleaseRefusedError(`The item changed since you reviewed it (it is now at ${head.commit.slice(0, 12)}); review it again`);
    }
    // Checked again after the await above: another release of the item (autoRelease, a second tab) may have been queued meanwhile.
    if (this.store.itemRuns(of.itemId).some((run) => ACTIVE_STATUSES.includes(run.status))) throw new ReleaseRefusedError("Wait for the item's runs to finish");
    if (this.store.countRuns(job.id, WAITING_STATUSES) >= MAX_QUEUED_PER_JOB) {
      throw new QueueFullError(`Job already has ${MAX_QUEUED_PER_JOB} runs waiting to start`);
    }
    const how = auto ? "automatically, as the job releases checked, implemented work" : `by ${requestedBy ?? "the owner"}`;
    let run: Run;
    if (job.releaseInstructions) {
      const agent = job.agent ?? this.store.getSettings().defaultAgent;
      run = this.store.createRelease(latest, agent, job.releaseInstructions, "release");
      this.note(run.id, `Queued (release of run #${latest.id}'s item ${how}, agent: ${agent})`);
    } else {
      run = this.store.createRelease(latest, latest.agent, job.shipCommand!);
      this.note(run.id, `Queued (ship of run #${latest.id}'s item ${how}: ${job.shipCommand})`);
    }
    this.store.updateRun(run.id, { requestedBy: auto ? "autoRelease" : (requestedBy ?? null) });
    this.pump();
    return this.store.getRun(run.id)!;
  }

  /**
   * What releasing an item would release, for the owner's confirmation: its newest commit, how far
   * the base branch on origin has moved since (after a quick fetch) and whether it merges cleanly,
   * the size of its changes, its check, and how the job releases. Null when it has no changes.
   */
  async releasePreview(of: Run) {
    const job = this.store.getJob(of.jobId);
    if (!job) return null;
    const runs = this.store.itemRuns(of.itemId);
    const head = await this.itemHead(job, runs.at(-1)!);
    if (!head) return null;
    let target = job.baseRef;
    if (await isFetchableBranch(job.repoPath, job.baseRef)) {
      const branch = baseBranch(job.baseRef);
      target = `refs/remotes/${REMOTE}/${branch}`;
      await git(job.repoPath, ["fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${branch}:${target}`], 15_000).catch(() => undefined);
    }
    const count = async (range: string) => Number(await git(job.repoPath, ["rev-list", "--count", range]).catch(() => "0"));
    const behind = await count(`${head.commit}..${target}`);
    const ahead = await count(`${target}..${head.commit}`);
    const conflicts = behind > 0 && ahead > 0 ? await git(job.repoPath, ["merge-tree", "--write-tree", "--name-only", target, head.commit]).then(() => false, () => true) : false;
    const stats = (await git(job.repoPath, ["diff", "--numstat", `${target}...${head.commit}`]).catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const work = runs.filter((run) => run.mode !== "ask" && !RELEASE_MODES.includes(run.mode)).at(-1);
    return {
      head: head.commit,
      headLabel: head.label,
      base: target.replace("refs/remotes/", ""),
      ahead,
      behind,
      conflicts,
      files: stats.length,
      additions: stats.reduce((sum, [added]) => sum + (Number(added) || 0), 0),
      deletions: stats.reduce((sum, [, deleted]) => sum + (Number(deleted) || 0), 0),
      checkCommand: job.checkCommand,
      checkStatus: work?.checkStatus ?? null,
      kind: job.releaseInstructions ? ("agent" as const) : ("script" as const),
      agent: job.releaseInstructions ? (job.agent ?? this.store.getSettings().defaultAgent) : null,
      instructions: job.releaseInstructions ?? job.shipCommand ?? "",
      verifyCommand: job.verifyCommand,
    };
  }

  /** Queues a run that was waiting for approval; null when the run isn't waiting. */
  approve(runId: number, requestedBy?: string): Run | null {
    const run = this.store.getRun(runId);
    if (run?.status !== "awaiting_approval") return null;
    if (!this.store.getJob(run.jobId)?.enabled) throw new JobPausedError("Job is paused; resume it to approve its runs");
    this.store.updateRun(runId, { status: "queued", requestedBy: requestedBy ?? null });
    this.note(runId, requestedBy ? `Approved by ${requestedBy}; queued` : "Approved; queued");
    this.pump();
    return this.store.getRun(runId);
  }

  /**
   * Runs the job's watch command in its repository and starts one run for each item it prints that
   * wasn't seen before. A check already in progress for the job is joined, not repeated.
   */
  watch(job: Job): Promise<WatchResult> {
    const current = this.watching.get(job.id);
    if (current) return current;
    const check = this.checkWatch(job).finally(() => this.watching.delete(job.id));
    this.watching.set(job.id, check);
    return check;
  }

  private async checkWatch(job: Job): Promise<WatchResult> {
    const result: WatchResult = { runs: [], seen: 0, error: null };
    if (!job.watchCommand) return { ...result, error: "This job has no watch command" };
    try {
      const parsed = parseWatchOutput(await runWatchCommand(job.watchCommand, job.repoPath, this.env));
      result.error = parsed.error;
      const seen = this.store.seenItems(job.id, parsed.items.map((item) => item.id));
      result.seen = seen.size;
      for (const item of parsed.items) {
        if (seen.has(item.id)) continue;
        const latest = this.store.getJob(job.id);
        if (!latest?.enabled) {
          result.error = "The job was paused during the check; the rest wait for the next one";
          break;
        }
        try {
          // The run and the record of its item are written together, so a crash can't start an item twice.
          const started = this.store.transaction(() => {
            const triggered = this.trigger(latest, "watch", item.payload, { pump: false });
            if ("run" in triggered) this.store.recordItem(job.id, item.id, triggered.run.id);
            return triggered;
          });
          if ("run" in started) {
            this.pump();
            result.runs.push(this.store.getRun(started.run.id)!);
          }
        } catch (error) {
          if (!(error instanceof QueueFullError)) throw error;
          // Unrecorded items start runs at a later check, once the queue has room.
          result.error = `${error.message}; the rest wait for the next check`;
          break;
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    const before = this.store.getJob(job.id)?.watchError ?? null;
    this.store.setWatchResult(job.id, result.error);
    if (result.error && !before) this.emit("watchFailed", job, result.error);
    return result;
  }

  /** Queues another attempt of a failed run, with backoff, while its job allows more. */
  retry(run: Run): Run | null {
    // A release may have done part of something irreversible: only the owner starts another.
    if (RELEASE_MODES.includes(run.mode)) return null;
    const job = this.store.getJob(run.jobId);
    if (!job?.enabled || run.attempt > job.retries) return null;
    const notBefore = new Date(Date.now() + this.retryDelayMs * 4 ** (run.attempt - 1));
    const next = this.store.createRetry(run, notBefore);
    const attempt = `attempt ${next.attempt} of ${job.retries + 1}`;
    this.note(run.id, `Retrying as run #${next.id} after ${notBefore.toISOString()} (${attempt})`);
    this.note(next.id, `Queued (retry of run #${run.id}, ${attempt}, agent: ${next.agent}); starts after ${notBefore.toISOString()}`);
    return next;
  }

  cancel(runId: number): Run | null {
    const run = this.store.getRun(runId);
    if (!run) return null;
    if (run.status === "awaiting_approval") {
      this.note(runId, "Dismissed without running");
      return this.finish(runId, { status: "canceled" });
    }
    if (run.status === "queued") {
      this.note(runId, "Canceled before it started");
      return this.finish(runId, { status: "canceled" });
    }
    this.active.get(runId)?.stop("canceled");
    return this.store.getRun(runId);
  }

  isActive(runId: number): boolean {
    return this.active.has(runId);
  }

  /** Starts queued runs while slots are free, one run per job at a time; retries wait for their time. */
  pump(): void {
    if (this.stopping) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const { maxConcurrent } = this.store.getSettings();
    let wakeAt = Infinity;
    for (const run of this.store.queuedRuns()) {
      const notBefore = run.notBefore ? Date.parse(run.notBefore) : 0;
      if (notBefore > Date.now()) {
        wakeAt = Math.min(wakeAt, notBefore);
        continue;
      }
      if (this.active.size >= maxConcurrent) break;
      if ([...this.active.values()].some((a) => a.jobId === run.jobId)) continue;
      this.start(run);
    }
    if (wakeAt !== Infinity) {
      // Re-check at least every minute: timers don't advance while the Mac sleeps, but the clock does.
      this.wakeTimer = setTimeout(() => this.pump(), Math.min(wakeAt - Date.now(), 60_000));
      this.wakeTimer.unref();
    }
  }

  /** Stops every running agent and waits (bounded) for their runs to wind down. */
  async shutdown(): Promise<void> {
    // Queued runs stay queued for the next start instead of starting mid-shutdown.
    this.stopping = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const active of this.active.values()) active.stop("interrupted");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(this.executions),
      new Promise((resolve) => (timer = setTimeout(resolve, this.killGraceMs + 5_000))),
    ]);
    clearTimeout(timer);
  }

  private start(queued: Run): void {
    // The job's agent when the run starts, not when it was queued or waited for approval: changing the
    // job's agent or the default applies to runs that haven't started. A release script runs no agent.
    let run = queued;
    const job = this.store.getJob(run.jobId);
    const agent = job?.agent ?? this.store.getSettings().defaultAgent;
    if (job && run.mode !== "ship" && agent !== run.agent) {
      this.note(run.id, `Agent: ${agent} (the job's agent now; it was ${run.agent} when queued)`);
      run = this.store.updateRun(run.id, { agent });
    }
    const active: ActiveRun = {
      jobId: run.jobId,
      token: randomUUID(),
      child: null,
      killTimer: null,
      stopReason: null,
      stop: (reason) => {
        if (active.stopReason) return;
        active.stopReason = reason;
        if (active.child) terminate(active, this.killGraceMs);
      },
    };
    this.active.set(run.id, active);
    this.store.updateRun(run.id, { status: "running", startedAt: new Date().toISOString() });
    const execution = this.execute(run, active).finally(() => {
      this.active.delete(run.id);
      this.executions.delete(execution);
      this.pump();
    });
    this.executions.add(execution);
  }

  private async execute(run: Run, active: ActiveRun): Promise<void> {
    const job = this.store.getJob(run.jobId);
    if (!job) {
      this.finish(run.id, { status: "failed", error: "Job was deleted" });
      return;
    }
    const deadline = Date.now() + job.timeoutMinutes * 60_000;
    const timer = setTimeout(() => {
      this.note(run.id, `Timed out after ${job.timeoutMinutes} min; stopping`);
      active.stop("timed_out");
    }, job.timeoutMinutes * 60_000);

    let worktree: string | null = null;
    let branch: string | null = null;
    let baseCommit: string | null = null;
    try {
      if (run.mode === "ship") {
        await this.executeReleaseScript(job, run, active, deadline);
        return;
      }
      const ask = run.mode === "ask";
      const release = run.mode === "release";
      // Every run of an item works in the same place, so the agent's session (kept per directory) carries over.
      // Freeing it first may commit a kept worktree's leftovers, which the base below then includes.
      const dir = path.join(this.worktreeDir, `job-${job.id}`, `item-${run.itemId}`);
      await this.freeWorktree(job, run.id, dir);
      // Before making a checkout: a run whose agent is gone fails at once.
      const command = this.agentCommand(run.agent);
      worktree = dir;
      const previous = run.followUpOf === null ? null : await this.previousRun(run.followUpOf);
      const head = previous ? await this.itemHead(job, previous.run) : null;
      const base = head ?? (await this.resolveBase(job, run.id));
      baseCommit = base.commit;
      mkdirSync(path.dirname(worktree), { recursive: true });
      if (ask) {
        await git(job.repoPath, ["worktree", "add", "--detach", worktree, baseCommit]);
        this.store.updateRun(run.id, { worktree, baseCommit });
        this.note(run.id, `Checkout ${worktree} (discarded after) at ${base.label} (${baseCommit.slice(0, 12)})`);
      } else {
        branch = `pi-jobs/${slugify(job.name)}/run-${run.id}`;
        await git(job.repoPath, ["worktree", "add", "-b", branch, worktree, baseCommit]);
        this.store.updateRun(run.id, { branch, worktree, baseCommit });
        this.note(run.id, `Worktree ${worktree} on ${branch} from ${base.label} (${baseCommit.slice(0, 12)})`);
      }

      let exitCode: number | null = null;
      if (!active.stopReason) {
        const session = this.sessionFor(run, command);
        if (session.id) this.store.updateRun(run.id, { sessionId: session.id });
        const prompt = buildPrompt(job, run, branch, baseCommit, previous, { baseLabel: base.label, resumed: session.resumed });
        const argv = withSession(buildArgv(command, prompt), session.id);
        this.note(run.id, `Starting ${run.agent}: ${command}${session.id ? ` (${session.resumed ? "resuming" : "new"} session ${session.id})` : ""}`);
        exitCode = await this.runProcess(run.id, active, argv, worktree, deadline, release ? releaseEnv(job, run, baseCommit, head?.branch ?? null) : {});
        this.store.updateRun(run.id, { exitCode });
        this.note(run.id, `Agent exited with ${exitCode === null ? "a signal" : `code ${exitCode}`}`);
      }

      if (ask) {
        await this.removeWorktree(job, worktree);
        const status: RunStatus = runStatus(active.stopReason, exitCode === 0);
        this.note(run.id, "Removed the checkout; a question keeps no changes");
        this.finish(
          run.id,
          {
            status,
            worktree: null,
            headCommit: baseCommit,
            commits: 0,
            error: active.stopReason === "interrupted" ? INTERRUPTED : null,
          },
          status === "timed_out" || (status === "failed" && active.stopReason !== "canceled"),
        );
        return;
      }

      let checkStatus: Run["checkStatus"] = null;
      // A release runs the repository's own tests and may already have pushed: a check after it would decide nothing.
      if (job.checkCommand && !release && exitCode === 0 && !active.stopReason) {
        this.note(run.id, `Running check: ${job.checkCommand}`);
        const checkCode = await this.runProcess(run.id, active, ["/bin/sh", "-c", job.checkCommand], worktree, deadline);
        checkStatus = checkCode === 0 ? "passed" : "failed";
        this.note(run.id, `Check ${checkStatus}${checkCode === null ? "" : ` (code ${checkCode})`}`);
      }

      const committed = await this.commitChanges(job, run, worktree, baseCommit);
      const { headCommit } = committed;
      // A release is checked, not taken on the agent's word (agents often exit 0 after stopping at a failed
      // step): its report mustn't say "Not released", the item's result must be on the base branch on
      // origin, and the job's verify command must pass.
      let releaseError: string | null = null;
      if (release && exitCode === 0 && !active.stopReason) {
        releaseError = releaseOutcome(this.readSummary(run.id)) ?? (await this.releasedCheck(job, run.id, baseCommit));
        if (!releaseError) releaseError = await this.verify(job, run, active, worktree, deadline);
      }
      // What a release leaves unreleased: commits not on the base branch it pushed to (a rebase there brings in others' commits).
      const commits = release ? await this.unreleasedCommits(job, worktree, baseCommit) : committed.commits;
      let status: RunStatus = runStatus(active.stopReason, exitCode === 0 && checkStatus !== "failed" && !releaseError);

      let pushedTo: string | null = null;
      let pushError: string | null = null;
      if (status === "succeeded" && commits > 0 && job.pushBranch && !release) {
        try {
          await git(job.repoPath, ["push", "--quiet", REMOTE, `refs/heads/${branch}:refs/heads/${branch}`], NETWORK_TIMEOUT_MS);
          pushedTo = REMOTE;
          this.note(run.id, `Pushed ${branch} to ${REMOTE}`);
        } catch (error) {
          pushError = `Could not push ${branch} to ${REMOTE}: ${(error as Error).message}`;
          this.note(run.id, pushError);
          status = "failed";
        }
      }

      if (status === "succeeded") {
        await this.removeWorktree(job, worktree);
        worktree = null;
        if (commits === 0 && branch) {
          await git(job.repoPath, ["branch", "-D", branch]);
          branch = null;
          this.note(run.id, release ? `Everything it committed is on ${job.baseRef}; removed the worktree and branch` : "No changes; removed the worktree and branch");
        } else {
          this.note(run.id, `${commits} commit(s) on ${branch}; removed the worktree`);
        }
      } else {
        this.note(run.id, `Kept the worktree for inspection: ${worktree}`);
      }
      // A failed check or push means the agent finished its work; running it again would redo that.
      // A release may have done part of something irreversible, so only the owner starts another.
      const retryable = !release && (status === "timed_out" || (status === "failed" && checkStatus !== "failed" && !pushError));
      const finished = this.finish(
        run.id,
        {
          status,
          branch,
          worktree,
          headCommit,
          commits,
          checkStatus,
          pushedTo,
          error: active.stopReason === "interrupted" ? INTERRUPTED : (pushError ?? releaseError),
        },
        retryable,
      );
      if (finished.status === "succeeded" && finished.mode === "change" && (finished.commits ?? 0) > 0) await this.autoRelease(job, finished);
      if (finished.status === "succeeded" && release) await this.pruneItemBranches(job, finished);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.note(run.id, `Error: ${message}`);
      // A question's checkout is never worth keeping.
      if (run.mode === "ask" && worktree) {
        await this.removeWorktree(job, worktree).catch(() => undefined);
        worktree = null;
      }
      this.finish(
        run.id,
        { status: "failed", error: message.split("\n")[0] ?? message, branch, worktree, baseCommit },
        active.stopReason !== "canceled" && run.mode !== "release" && !(error instanceof AgentMissingError),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A release by script: the job's ship command in a temporary checkout of the item's newest result, with
   * what it releases in PI_JOBS_RELEASE_* (and the older PI_JOBS_SHIP_*) variables. It keeps nothing and is never retried by itself.
   */
  private async executeReleaseScript(job: Job, run: Run, active: ActiveRun, deadline: number): Promise<void> {
    let worktree: string | null = null;
    try {
      const previous = run.followUpOf === null ? null : this.store.getRun(run.followUpOf);
      const head = previous ? await this.itemHead(job, previous) : null;
      if (!head) throw new Error("Nothing to release: this item has no changes");
      const command = run.instructions ?? "";
      const dir = path.join(this.worktreeDir, `job-${job.id}`, `item-${run.itemId}`);
      await this.freeWorktree(job, run.id, dir);
      mkdirSync(path.dirname(dir), { recursive: true });
      await git(job.repoPath, ["worktree", "add", "--detach", dir, head.commit]);
      worktree = dir;
      this.store.updateRun(run.id, { worktree, baseCommit: head.commit, headCommit: head.commit, commits: 0 });
      this.note(run.id, `Checkout ${dir} (discarded after) at ${head.label} (${head.commit.slice(0, 12)})`);
      let exitCode: number | null = null;
      if (!active.stopReason) {
        this.note(run.id, `Starting release script: ${command}`);
        exitCode = await this.runProcess(run.id, active, ["/bin/sh", "-c", command], dir, deadline, releaseEnv(job, run, head.commit, head.branch));
        this.store.updateRun(run.id, { exitCode });
        this.note(run.id, `Release script exited with ${exitCode === null ? "a signal" : `code ${exitCode}`}`);
      }
      const verifyError = exitCode === 0 ? await this.verify(job, run, active, dir, deadline) : null;
      await this.removeWorktree(job, dir);
      worktree = null;
      const status: RunStatus = runStatus(active.stopReason, exitCode === 0 && !verifyError);
      const error =
        active.stopReason === "interrupted"
          ? INTERRUPTED
          : status !== "failed"
            ? null
            : (verifyError ?? `The release script exited with ${exitCode === null ? "a signal" : `code ${exitCode}`}`);
      this.finish(run.id, { status, worktree: null, error });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.note(run.id, `Error: ${message}`);
      if (worktree) await this.removeWorktree(job, worktree).catch(() => undefined);
      this.finish(run.id, { status: "failed", worktree: null, error: message.split("\n")[0] ?? message });
    }
  }

  /** The command line of a run's agent, from Settings. */
  private agentCommand(agent: string): string {
    const { agents } = this.store.getSettings();
    if (!Object.hasOwn(agents, agent)) throw new AgentMissingError(`The agent "${agent}" is no longer in Settings; add it back or change the job's agent`);
    return agents[agent]!.command;
  }

  /**
   * Why a release that exited 0 isn't out: the item's result (`commit`) isn't on the job's base branch
   * on origin after a fetch (or locally, for a base that isn't a branch on origin). Null when it is.
   */
  private async releasedCheck(job: Job, runId: number, commit: string): Promise<string | null> {
    const branch = baseBranch(job.baseRef);
    let target = job.baseRef;
    if (await isFetchableBranch(job.repoPath, job.baseRef)) {
      target = `refs/remotes/${REMOTE}/${branch}`;
      try {
        await git(job.repoPath, ["fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${branch}:${target}`], NETWORK_TIMEOUT_MS);
      } catch (error) {
        this.note(runId, `Could not fetch ${branch} to check the release (${(error as Error).message}); using the last fetched tip`);
      }
    }
    const released = await git(job.repoPath, ["merge-base", "--is-ancestor", commit, target]).then(() => true, () => false);
    this.note(runId, released ? `The item's result is on ${target.replace("refs/remotes/", "")}` : `The item's result (${commit.slice(0, 12)}) is not on ${target.replace("refs/remotes/", "")}`);
    return released ? null : `The item's result isn't on ${target.replace("refs/remotes/", "")}, so it wasn't released`;
  }

  /**
   * Releases cut off by a server stop (since `since`) may have gone out before it: each whose item
   * result is now on the base branch on origin says so, so the owner checks before releasing again.
   */
  async recheckInterruptedReleases(since: string): Promise<void> {
    for (const run of this.store.interruptedReleases(since)) {
      const job = this.store.getJob(run.jobId);
      if (!job || !run.baseCommit) continue;
      if ((await this.releasedCheck(job, run.id, run.baseCommit)) !== null) continue;
      this.store.updateRun(run.id, {
        error: `${INTERRUPTED}, but the item's result is on ${baseBranch(job.baseRef)}: it may have gone out. Check it before releasing again`,
      });
    }
  }

  /**
   * After a release, deletes the item's run branches whose commits are all on the base branch: they
   * are released, so keeping them only clutters the repository. Runs keep the names for the record.
   */
  private async pruneItemBranches(job: Job, release: Run): Promise<void> {
    const target = (await isFetchableBranch(job.repoPath, job.baseRef)) ? `refs/remotes/${REMOTE}/${baseBranch(job.baseRef)}` : job.baseRef;
    const pruned: string[] = [];
    for (const run of this.store.itemRuns(release.itemId)) {
      if (!run.branch || run.worktree || run.id === release.id) continue;
      const tip = await git(job.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`]).catch(() => null);
      if (!tip) continue;
      const released = await git(job.repoPath, ["merge-base", "--is-ancestor", tip, target]).then(() => true, () => false);
      if (released && (await git(job.repoPath, ["branch", "-D", run.branch]).then(() => true, () => false))) pruned.push(run.branch);
    }
    if (pruned.length > 0) this.note(release.id, `Deleted released branches: ${pruned.join(", ")}`);
  }

  /** Runs the job's verify command after a release, in its checkout; why it failed, or null. */
  private async verify(job: Job, run: Run, active: ActiveRun, cwd: string, deadline: number): Promise<string | null> {
    if (!job.verifyCommand || active.stopReason) return null;
    this.note(run.id, `Running verify command: ${job.verifyCommand}`);
    const code = await this.runProcess(run.id, active, ["/bin/sh", "-c", job.verifyCommand], cwd, deadline);
    this.note(run.id, `Verify command ${code === 0 ? "passed" : `failed${code === null ? "" : ` (code ${code})`}`}`);
    return code === 0 ? null : `The verify command failed${code === null ? "" : ` with code ${code}`}`;
  }

  /** Commits on HEAD that the base branch on origin doesn't have (as last fetched or pushed), else since `baseCommit`. */
  private async unreleasedCommits(job: Job, worktree: string, baseCommit: string): Promise<number> {
    const tracking = `refs/remotes/${REMOTE}/${baseBranch(job.baseRef)}`;
    const upstream = (await resolvesToCommit(job.repoPath, tracking)) ? tracking : baseCommit;
    return Number(await git(worktree, ["rev-list", "--count", "HEAD", "--not", upstream, baseCommit]));
  }

  /**
   * Releases an item whose run just succeeded with changes, when its job releases automatically and the
   * run earned it: its check passed and its report says the work was implemented or fixed (not a
   * proposal or a triage note waiting for the owner).
   */
  private async autoRelease(job: Job, run: Run): Promise<void> {
    if (!job.autoRelease || !job.enabled || (!job.releaseInstructions && !job.shipCommand)) return;
    const verdict = parseVerdict(run.summary);
    if (run.checkStatus !== "passed" || !RELEASABLE_VERDICTS.includes(verdict)) {
      const why = run.checkStatus !== "passed" ? "its check didn't pass" : `its report's verdict is ${verdict.replace("_", " ")}`;
      this.note(run.id, `Not releasing automatically: ${why}; release it by hand if it's ready`);
      return;
    }
    try {
      const release = await this.release(run, { auto: true });
      this.note(run.id, `Releasing automatically: run #${release.id}`);
    } catch (error) {
      this.note(run.id, `Could not release automatically: ${(error as Error).message}`);
    }
  }

  /** The run a follow-up continues, with the end of what its agent printed. */
  private async previousRun(id: number): Promise<PreviousRun | null> {
    const run = this.store.getRun(id);
    if (!run) return null;
    const output = agentOutput(await readFile(this.logPath(id), "utf8").catch(() => ""));
    return { run, output: output.length > MAX_PREVIOUS_OUTPUT ? `[earlier output omitted]\n${output.slice(-MAX_PREVIOUS_OUTPUT)}` : output };
  }

  /**
   * Where a follow-up starts: the newest commits among the run it follows up on and that run's own
   * earlier runs (questions leave none), or null for the job's base when none of them committed.
   */
  private async itemHead(job: Job, previous: Run): Promise<{ commit: string; label: string; branch: string | null } | null> {
    for (let run: Run | null = previous; run; ) {
      // A release's head is the item's newest result whether or not it went out: it may have rebased,
      // committed a version bump or pushed before a later step failed, leaving nothing on a branch.
      if (run.mode === "release" && run.headCommit) {
        return { commit: run.headCommit, label: `run #${run.id}`, branch: null };
      }
      if (run.headCommit && (run.commits ?? 0) > 0) {
        if (!(await resolvesToCommit(job.repoPath, run.headCommit))) {
          throw new Error(`Run #${run.id}'s result (${run.headCommit.slice(0, 12)}) is no longer in the repository`);
        }
        return { commit: run.headCommit, label: `run #${run.id}`, branch: run.branch };
      }
      const parent: number | null = run.followUpOf ?? run.retryOf;
      run = parent === null ? null : this.store.getRun(parent);
    }
    return null;
  }

  /**
   * The agent session a run uses: the one the run it follows up on or retries used, when the same
   * agent ran it, so the conversation continues; a new one otherwise. None for agents without sessions.
   */
  private sessionFor(run: Run, command: string): { id: string | null; resumed: boolean } {
    if (!supportsSessions(command)) return { id: null, resumed: false };
    // A retry starts over in a fresh checkout, so it must not inherit the failed attempt's conversation.
    if (run.retryOf !== null) return { id: randomUUID(), resumed: false };
    const parent = run.followUpOf === null ? null : this.store.getRun(run.followUpOf);
    // Only an agent that actually ran left a session to continue.
    if (parent?.sessionId && parent.agent === run.agent && parent.itemId === run.itemId && parent.exitCode !== null) {
      return { id: parent.sessionId, resumed: true };
    }
    return { id: randomUUID(), resumed: false };
  }

  /**
   * Clears an item's working directory for its next run. A run that failed (or was stopped by a
   * server restart) kept its worktree there; anything left uncommitted in it is committed to that
   * run's branch first, so removing the worktree loses nothing.
   */
  private async freeWorktree(job: Job, runId: number, worktree: string): Promise<void> {
    for (const kept of this.store.runsWithWorktree(worktree)) {
      if (existsSync(worktree) && kept.branch && kept.baseCommit) {
        const dirty = (await git(worktree, ["status", "--porcelain"]).catch(() => "")) !== "";
        if (dirty) {
          const { headCommit, commits } = await this.commitChanges(job, kept, worktree, kept.baseCommit);
          this.store.updateRun(kept.id, { headCommit, commits });
          this.note(runId, `Committed run #${kept.id}'s uncommitted work to ${kept.branch}`);
        }
      } else if (existsSync(worktree) && (await git(worktree, ["status", "--porcelain"]).catch(() => "")) !== "") {
        throw new Error(`Run #${kept.id}'s worktree ${worktree} has uncommitted changes and no branch to keep them on`);
      }
      this.store.updateRun(kept.id, { worktree: null });
      this.note(runId, `Removing run #${kept.id}'s kept worktree to reuse its directory`);
    }
    if (!existsSync(worktree)) return;
    await git(job.repoPath, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true });
    await git(job.repoPath, ["worktree", "prune"]).catch(() => undefined);
  }

  private async removeWorktree(job: Job, worktree: string): Promise<void> {
    await git(job.repoPath, ["worktree", "remove", "--force", worktree]);
    // Drop the job's worktree directory once its last kept worktree is gone.
    await rmdir(path.dirname(worktree)).catch(() => undefined);
  }

  /**
   * The commit a run starts from. For a branch name (or `origin/<branch>`), fetch it from `origin`
   * and use the pushed tip, so runs see what was pushed from any machine and never unpushed local
   * work. Tags, revision expressions (`main~1`), `refs/...`, `HEAD`, commits and repos without
   * `origin` use local refs.
   */
  private async resolveBase(job: Job, runId: number): Promise<{ commit: string; label: string }> {
    const ref = job.baseRef;
    const branch = baseBranch(ref);
    if (await isFetchableBranch(job.repoPath, ref)) {
      const tracking = `refs/remotes/${REMOTE}/${branch}`;
      try {
        await git(job.repoPath, ["fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${branch}:${tracking}`], NETWORK_TIMEOUT_MS);
      } catch (error) {
        this.note(runId, `Could not fetch ${branch} from ${REMOTE} (${(error as Error).message}); using the last fetched or local ref`);
      }
      if (await resolvesToCommit(job.repoPath, tracking)) {
        return { commit: await git(job.repoPath, ["rev-parse", `${tracking}^{commit}`]), label: `${REMOTE}/${branch}` };
      }
    }
    return { commit: await git(job.repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]), label: ref };
  }

  private async commitChanges(job: Job, run: Run, worktree: string, baseCommit: string) {
    await git(worktree, ["add", "-A"]);
    if ((await git(worktree, ["status", "--porcelain"])) !== "") {
      await git(worktree, [
        "-c",
        "user.name=pi-jobs",
        "-c",
        "user.email=pi-jobs@localhost",
        "commit",
        "--no-verify",
        "--quiet",
        "-m",
        `pi-jobs: ${job.name} (run #${run.id})`,
        "-m",
        `Pi-Jobs-Run: ${run.id}`,
      ]);
      this.note(run.id, "Committed the agent's uncommitted changes");
    }
    const headCommit = await git(worktree, ["rev-parse", "HEAD"]);
    const commits = Number(await git(worktree, ["rev-list", "--count", `${baseCommit}..HEAD`]));
    return { headCommit, commits };
  }

  private runProcess(
    runId: number,
    active: ActiveRun,
    argv: string[],
    cwd: string,
    deadline: number,
    extraEnv: Record<string, string> = {},
  ): Promise<number | null> {
    const fd = openSync(this.logPath(runId), "a");
    const env = { ...this.env, PI_JOBS_RUN_ID: String(runId), PI_JOBS_JOB_ID: String(active.jobId), PI_JOBS_RUN_TOKEN: active.token, ...extraEnv };
    return runInGroup(active, {
      argv,
      cwd,
      env,
      stdio: ["ignore", fd, fd],
      token: active.token,
      onSpawn: () => {
        if (Date.now() >= deadline) active.stop("timed_out");
      },
      onExit: () => closeSync(fd),
    });
  }

  private finish(runId: number, patch: Parameters<Store["updateRun"]>[1], retryable = false): Run {
    const run = this.store.updateRun(runId, { ...patch, summary: this.readSummary(runId), finishedAt: new Date().toISOString() });
    this.note(runId, `Finished: ${run.status}`);
    const retry = retryable ? this.retry(run) : null;
    this.emit("finished", run, { retrying: retry !== null });
    return run;
  }

  /** Saves the summaries of runs that finished before pi-jobs kept them. */
  backfillSummaries(): void {
    for (const id of this.store.runsWithoutSummary()) this.store.updateRun(id, { summary: this.readSummary(id) });
  }

  /** The end of what the agent printed, which is where agents put their final report. */
  private readSummary(runId: number): string {
    let log = "";
    try {
      log = readFileSync(this.logPath(runId), "utf8");
    } catch {
      return "";
    }
    const output = agentOutput(log);
    return output.length > MAX_SUMMARY ? output.slice(-MAX_SUMMARY) : output;
  }

  private note(runId: number, message: string): void {
    appendFileSync(this.logPath(runId), `[pi-jobs ${new Date().toISOString()}] ${message}\n`);
  }
}

/** How a run ended: how it was stopped, if it was, else whether it did its work. */
function runStatus(stopReason: StopReason | null, ok: boolean): RunStatus {
  if (stopReason === "timed_out") return "timed_out";
  if (stopReason === "canceled") return "canceled";
  return stopReason || !ok ? "failed" : "succeeded";
}

/** What a release script or agent is told it releases; PI_JOBS_SHIP_* are the names from before releases. */
function releaseEnv(job: Job, run: Run, commit: string, branch: string | null): Record<string, string> {
  return {
    PI_JOBS_RELEASE_COMMIT: commit,
    PI_JOBS_RELEASE_BRANCH: branch ?? "",
    PI_JOBS_SHIP_COMMIT: commit,
    PI_JOBS_SHIP_BRANCH: branch ?? "",
    PI_JOBS_BASE_REF: job.baseRef,
    PI_JOBS_REPO: job.repoPath,
    PI_JOBS_ITEM_ID: String(run.itemId),
  };
}
