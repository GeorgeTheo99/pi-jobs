import { spawn } from "node:child_process";
import type { Config } from "./config.ts";
import { withoutSessionEnv, signalGroup } from "./process.ts";
import { autoReleaseBlocker } from "./items.ts";
import { parseVerdict, summaryHeadline } from "./report.ts";
import type { Job, Run, Store } from "./store.ts";

const NOTIFY_TIMEOUT_MS = 30_000;

/** Events the owner hears about, through Settings' notify command. */
export type NotifyEvent = "approval" | "decision" | "review" | "staged" | "failed" | "released" | "release_failed" | "watch_failed" | "test";

export interface Notification {
  event: NotifyEvent;
  title: string;
  message: string;
  /** The page to open, relative to the UI (e.g. "/runs/12"). */
  path: string;
  jobId?: number;
  runId?: number;
}

const short = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * What the owner should hear about a run that just finished, if anything: work to review or decide
 * on, a failure no retry will fix, or how a release went. Questions and runs that will be retried say
 * nothing; their outcome comes with the next run.
 */
export function finishedNotification(run: Run, job: Job | null, retrying: boolean): Notification | null {
  if (run.mode === "ask" || retrying || run.status === "canceled") return null;
  const name = job?.name ?? `Job #${run.jobId}`;
  const headline = summaryHeadline(run.summary) ?? "";
  const base = { path: `/runs/${run.id}`, jobId: run.jobId, runId: run.id };
  if (run.mode === "release" || run.mode === "ship") {
    // A staging release waits for the owner to promote it; a promotion is the release that goes out.
    if (run.stage === "staging" && run.status === "succeeded") {
      return { ...base, event: "staged", title: `Staged, ready to promote: ${name}`, message: short(headline || `Run #${run.id} released the item to staging.`) };
    }
    const what = run.stage === "production" ? "Promot" : "Releas";
    return run.status === "succeeded"
      ? { ...base, event: "released", title: `${what}ed: ${name}`, message: short(headline || `Run #${run.id} released the item.`) }
      : { ...base, event: "release_failed", title: `${what}e failed: ${name}`, message: short(run.error ?? headline ?? "") };
  }
  if (run.status !== "succeeded") return { ...base, event: "failed", title: `Failed: ${name}`, message: short(run.error ?? headline) };
  // A command job's output isn't a report: only its failures need the owner.
  if (run.mode === "command") return null;
  const verdict = parseVerdict(run.summary);
  if (verdict === "needs_decision") return { ...base, event: "decision", title: `Needs your decision: ${name}`, message: short(headline) };
  if ((run.commits ?? 0) > 0) {
    // Work the job releases by itself is announced by its release instead.
    if (job?.autoRelease && (job.releaseInstructions || job.shipCommand) && job.enabled && !autoReleaseBlocker(job, run)) return null;
    return { ...base, event: "review", title: `Ready to review: ${name}`, message: short(headline) };
  }
  return null;
}

/** Runs Settings' notify command for events that need the owner; it never blocks or fails the work that raised them. */
export class Notifier {
  private readonly store: Store;
  private readonly config: Config;
  private readonly env: NodeJS.ProcessEnv;

  constructor(store: Store, config: Config, env: NodeJS.ProcessEnv = process.env) {
    this.store = store;
    this.config = config;
    this.env = withoutSessionEnv(env);
  }

  /** The page's full address: Settings' public URL, else this server's own. */
  url(path: string): string {
    const base = this.store.getSettings().publicUrl ?? `http://${this.config.host}:${this.config.port}`;
    return `${base}${path}`;
  }

  /** Sends a notification; resolves with why it failed, or null (also when no command is set). */
  send(notification: Notification): Promise<string | null> {
    const command = this.store.getSettings().notifyCommand;
    if (!command) return Promise.resolve(null);
    return new Promise((resolve) => {
      const child = spawn("/bin/sh", ["-c", command], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...this.env,
          PI_JOBS_EVENT: notification.event,
          PI_JOBS_TITLE: notification.title,
          PI_JOBS_MESSAGE: notification.message,
          PI_JOBS_URL: this.url(notification.path),
          PI_JOBS_JOB_ID: notification.jobId === undefined ? "" : String(notification.jobId),
          PI_JOBS_RUN_ID: notification.runId === undefined ? "" : String(notification.runId),
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), NOTIFY_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(`Could not start the notify command: ${error.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const failure = code === 0 ? null : `The notify command exited with ${code === null ? "a signal" : `code ${code}`}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)!.slice(0, 200)}` : ""}`;
        if (failure) console.warn(`Notification "${notification.title}" failed: ${failure}`);
        resolve(failure);
      });
    });
  }
}
