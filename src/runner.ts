import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { rmdir } from "node:fs/promises";
import { promisify } from "node:util";
import { buildArgv } from "./agents.ts";
import { ACTIVE_STATUSES, type Job, type Run, type RunStatus, type Store, type Trigger } from "./store.ts";

const execFileP = promisify(execFile);

/** Webhook bursts beyond this many queued runs per job are rejected. */
export const MAX_QUEUED_PER_JOB = 20;
const MAX_PAYLOAD_IN_PROMPT = 20_000;
const PAYLOAD_TOKEN = "{{payload}}";
/** The remote runs start from and push result branches to. */
const REMOTE = "origin";
const NETWORK_TIMEOUT_MS = 120_000;
/** The wait before the first retry; each further retry waits 4x longer. */
const RETRY_DELAY_MS = 60_000;
/** Session-scoped variables that leak in when the server is started from inside an agent session. */
const SESSION_ENV = [
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_CODING_AGENT",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
];

type StopReason = "canceled" | "timed_out" | "interrupted";

interface ActiveRun {
  jobId: number;
  /** Random per-run marker inherited by every process the run starts, unique across server instances. */
  token: string;
  child: ChildProcess | null;
  killTimer: NodeJS.Timeout | null;
  stopReason: StopReason | null;
  stop(reason: StopReason): void;
}

export class QueueFullError extends Error {}

export type TriggerResult = { run: Run } | { skipped: string };

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

export function buildPrompt(job: Job, run: Run, branch: string, baseCommit: string): string {
  const payload =
    run.payload && run.payload.length > MAX_PAYLOAD_IN_PROMPT
      ? `${run.payload.slice(0, MAX_PAYLOAD_IN_PROMPT)}\n[payload truncated]`
      : run.payload;
  const usesToken = job.prompt.includes(PAYLOAD_TOKEN);
  const body = job.prompt.replaceAll(PAYLOAD_TOKEN, payload ?? "(no payload)");
  const lines = [
    body.trim(),
    "",
    "---",
    `You are running unattended as pi-jobs run #${run.id} of the job "${job.name}" (trigger: ${run.trigger}).`,
    `- Your working directory is a fresh git worktree of ${job.repoPath} on branch ${branch}, based on ${job.baseRef} (${baseCommit.slice(0, 12)}).`,
    "- Nobody is watching: do not ask questions. Make reasonable decisions and finish the task.",
    "- Keep all changes in this worktree. Do not push, merge, deploy, or modify other checkouts.",
    "- Any uncommitted changes are committed to the branch for review when you exit.",
    "- End with a short summary of what you found and what you changed.",
  ];
  if (payload && !usesToken) lines.push("", "Trigger payload:", "```", payload, "```");
  // Process arguments cannot contain NUL bytes.
  return lines.join("\n").replaceAll("\0", "");
}

export class Runner extends EventEmitter<{ finished: [Run] }> {
  private readonly store: Store;
  private readonly env: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;
  private readonly retryDelayMs: number;
  private readonly active = new Map<number, ActiveRun>();
  private readonly executions = new Set<Promise<void>>();
  private stopping = false;
  /** Pumps again when the earliest waiting retry comes due. */
  private wakeTimer: NodeJS.Timeout | null = null;
  readonly logDir: string;
  readonly worktreeDir: string;

  constructor(options: RunnerOptions) {
    super();
    this.store = options.store;
    this.env = Object.fromEntries(
      Object.entries(options.env ?? process.env).filter(([key]) => !SESSION_ENV.includes(key)),
    );
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

  trigger(job: Job, trigger: Trigger, payload: string | null = null): TriggerResult {
    if (trigger === "schedule" && this.store.countRuns(job.id, ACTIVE_STATUSES) > 0) {
      return { skipped: "a run of this job is already queued or running" };
    }
    if (this.store.countRuns(job.id, ["queued"]) >= MAX_QUEUED_PER_JOB) {
      throw new QueueFullError(`Job already has ${MAX_QUEUED_PER_JOB} queued runs`);
    }
    const agent = job.agent ?? this.store.getSettings().defaultAgent;
    const run = this.store.createRun(job.id, trigger, agent, payload);
    this.note(run.id, `Queued (trigger: ${trigger}, agent: ${agent})`);
    this.pump();
    return { run: this.store.getRun(run.id)! };
  }

  /** A cron fire. A missed one (slept through, or due while the server was down) runs only if the job catches up. */
  fireSchedule(job: Job, missed: boolean): TriggerResult {
    this.store.markFired(job.id);
    if (missed && !job.catchUp) return { skipped: "its time was missed and catch-up is off" };
    return this.trigger(job, "schedule");
  }

  /** Queues another attempt of a failed run, with backoff, while its job allows more. */
  retry(run: Run): Run | null {
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

  private start(run: Run): void {
    const active: ActiveRun = {
      jobId: run.jobId,
      token: randomUUID(),
      child: null,
      killTimer: null,
      stopReason: null,
      stop: (reason) => {
        if (active.stopReason) return;
        active.stopReason = reason;
        if (active.child) this.killTree(active);
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
      const base = await this.resolveBase(job, run.id);
      baseCommit = base.commit;
      branch = `pi-jobs/${slugify(job.name)}/run-${run.id}`;
      worktree = path.join(this.worktreeDir, `job-${job.id}`, `run-${run.id}`);
      mkdirSync(path.dirname(worktree), { recursive: true });
      await git(job.repoPath, ["worktree", "add", "-b", branch, worktree, baseCommit]);
      this.store.updateRun(run.id, { branch, worktree, baseCommit });
      this.note(run.id, `Worktree ${worktree} on ${branch} from ${base.label} (${baseCommit.slice(0, 12)})`);

      let exitCode: number | null = null;
      if (!active.stopReason) {
        const { command } = this.store.getSettings().agents[run.agent];
        const argv = buildArgv(command, buildPrompt(job, run, branch, baseCommit));
        this.note(run.id, `Starting ${run.agent}: ${command}`);
        exitCode = await this.runProcess(run.id, active, argv, worktree, deadline);
        this.store.updateRun(run.id, { exitCode });
        this.note(run.id, `Agent exited with ${exitCode === null ? "a signal" : `code ${exitCode}`}`);
      }

      let checkStatus: Run["checkStatus"] = null;
      if (job.checkCommand && exitCode === 0 && !active.stopReason) {
        this.note(run.id, `Running check: ${job.checkCommand}`);
        const checkCode = await this.runProcess(run.id, active, ["/bin/sh", "-c", job.checkCommand], worktree, deadline);
        checkStatus = checkCode === 0 ? "passed" : "failed";
        this.note(run.id, `Check ${checkStatus}${checkCode === null ? "" : ` (code ${checkCode})`}`);
      }

      const { headCommit, commits } = await this.commitChanges(job, run, worktree, baseCommit);
      let status: RunStatus = active.stopReason
        ? active.stopReason === "timed_out"
          ? "timed_out"
          : active.stopReason === "canceled"
            ? "canceled"
            : "failed"
        : exitCode === 0 && checkStatus !== "failed"
          ? "succeeded"
          : "failed";

      let pushedTo: string | null = null;
      let pushError: string | null = null;
      if (status === "succeeded" && commits > 0 && job.pushBranch) {
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
        await git(job.repoPath, ["worktree", "remove", "--force", worktree]);
        // Drop the job's worktree directory once its last kept worktree is gone.
        await rmdir(path.dirname(worktree)).catch(() => undefined);
        worktree = null;
        if (commits === 0) {
          await git(job.repoPath, ["branch", "-D", branch]);
          branch = null;
          this.note(run.id, "No changes; removed the worktree and branch");
        } else {
          this.note(run.id, `${commits} commit(s) on ${branch}; removed the worktree`);
        }
      } else {
        this.note(run.id, `Kept the worktree for inspection: ${worktree}`);
      }
      // A failed check or push means the agent finished its work; running it again would redo that.
      const retryable = status === "timed_out" || (status === "failed" && checkStatus !== "failed" && !pushError);
      this.finish(
        run.id,
        {
          status,
          branch,
          worktree,
          headCommit,
          commits,
          checkStatus,
          pushedTo,
          error: active.stopReason === "interrupted" ? "The server stopped while this run was in progress" : pushError,
        },
        retryable,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.note(run.id, `Error: ${message}`);
      this.finish(
        run.id,
        { status: "failed", error: message.split("\n")[0] ?? message, branch, worktree, baseCommit },
        active.stopReason !== "canceled",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The commit a run starts from. For a branch name (or `origin/<branch>`), fetch it from `origin`
   * and use the pushed tip, so runs see what was pushed from any machine and never unpushed local
   * work. Tags, revision expressions (`main~1`), `refs/...`, `HEAD`, commits and repos without
   * `origin` use local refs.
   */
  private async resolveBase(job: Job, runId: number): Promise<{ commit: string; label: string }> {
    const ref = job.baseRef;
    const branch = ref.startsWith(`${REMOTE}/`) ? ref.slice(REMOTE.length + 1) : ref;
    if (await this.isFetchableBranch(job.repoPath, ref, branch)) {
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

  private async isFetchableBranch(repo: string, ref: string, branch: string): Promise<boolean> {
    if (ref === "HEAD" || ref.startsWith("refs/") || /^[0-9a-f]{7,40}$/i.test(ref)) return false;
    if (!(await git(repo, ["remote"])).split("\n").includes(REMOTE)) return false;
    if (await resolvesToCommit(repo, `refs/tags/${ref}`)) return false;
    try {
      // Rejects revision syntax (~ ^ : @{ ..) and anything else that is not a branch name.
      await git(repo, ["check-ref-format", "--branch", branch]);
      return !branch.startsWith("-");
    } catch {
      return false;
    }
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
  ): Promise<number | null> {
    const fd = openSync(this.logPath(runId), "a");
    let child: ChildProcess;
    try {
      // Its own process group, so the agent and everything it starts can be signalled together.
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: {
          ...this.env,
          PI_JOBS_RUN_ID: String(runId),
          PI_JOBS_JOB_ID: String(active.jobId),
          PI_JOBS_RUN_TOKEN: active.token,
        },
      });
    } catch (error) {
      closeSync(fd);
      return Promise.reject(new Error(`Could not start ${argv[0]}: ${(error as Error).message}`));
    }
    active.child = child;
    if (Date.now() >= deadline) active.stop("timed_out");
    // lsof reports resolved paths (/private/tmp, not /tmp); resolve now, while the worktree exists.
    const realCwd = realpathSync(cwd);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        closeSync(fd);
        active.child = null;
        if (active.killTimer) clearTimeout(active.killTimer);
        active.killTimer = null;
        done();
      };
      // A failed spawn emits "error" (and, on some versions, "close" as well); later errors are followed by "close".
      child.on("error", (error) => {
        if (child.pid === undefined) settle(() => reject(new Error(`Could not start ${argv[0]}: ${error.message}`)));
      });
      child.once("close", (code) =>
        settle(() => {
          // Reap anything left running: the agent's own group, plus processes it started in other
          // sessions (Pi's bash tool detaches each command).
          signalGroup(child.pid, "SIGKILL");
          void killRunProcesses(active.token, realCwd).finally(() => resolve(code));
        }),
      );
    });
  }

  private killTree(active: ActiveRun): void {
    const pid = active.child?.pid;
    signalGroup(pid, "SIGTERM");
    // Escalate if the agent ignores SIGTERM; cleared once it exits, so a reused PID is never hit.
    active.killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), this.killGraceMs);
    active.killTimer.unref();
  }

  private finish(runId: number, patch: Parameters<Store["updateRun"]>[1], retryable = false): Run {
    const run = this.store.updateRun(runId, { ...patch, finishedAt: new Date().toISOString() });
    this.note(runId, `Finished: ${run.status}`);
    if (retryable) this.retry(run);
    this.emit("finished", run);
    return run;
  }

  private note(runId: number, message: string): void {
    appendFileSync(this.logPath(runId), `[pi-jobs ${new Date().toISOString()}] ${message}\n`);
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * SIGKILLs every process left over from a run: those that inherited its PI_JOBS_RUN_TOKEN (macOS
 * `ps -E`; platform binaries hide their environment) and those whose working directory is inside
 * the run's worktree.
 */
async function killRunProcesses(token: string, worktree: string): Promise<void> {
  const pids = new Set<number>();
  const marker = `PI_JOBS_RUN_TOKEN=${token}`;
  for (const line of (await commandOutput("ps", ["-AEww", "-o", "pid=,command="])).split("\n")) {
    if (line.includes(marker)) pids.add(Number.parseInt(line, 10));
  }
  // lsof -F prints "p<pid>" then "n<cwd>" for each process.
  let pid = 0;
  for (const line of (await commandOutput("lsof", ["-nP", "-d", "cwd", "-Fpn"])).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && (line.slice(1) === worktree || line.startsWith(`n${worktree}/`))) pids.add(pid);
  }
  for (const target of pids) {
    if (!target || target === process.pid) continue;
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Stdout of a listing command, even when it exits non-zero (lsof does when some processes are unreadable). */
async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    return (await execFileP(command, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) console.error(`${command} failed while cleaning up after a run:`, error);
    return stdout ?? "";
  }
}

async function git(cwd: string, args: string[], timeout = 0): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout,
      // Never wait on a credential prompt; the server has no terminal.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function resolvesToCommit(dir: string, ref: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
