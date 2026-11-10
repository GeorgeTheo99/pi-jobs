import { Cron } from "croner";
import type { Job } from "./store.ts";

/** Returns an error message for an invalid cron expression, or null when it is valid. */
export function cronError(expression: string): string | null {
  try {
    new Cron(expression, { paused: true }).stop();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function nextRuns(expression: string, count: number): string[] {
  const cron = new Cron(expression, { paused: true });
  const runs = cron.nextRuns(count).map((date) => date.toISOString());
  cron.stop();
  return runs;
}

/** Keeps one in-process cron timer per enabled, scheduled job. Missed fires while the server is down are skipped. */
export class Scheduler {
  private readonly timers = new Map<number, Cron>();
  private readonly fire: (jobId: number) => void;

  constructor(fire: (jobId: number) => void) {
    this.fire = fire;
  }

  sync(job: Job): void {
    this.remove(job.id);
    if (!job.enabled || !job.schedule) return;
    this.timers.set(
      job.id,
      new Cron(job.schedule, { protect: true, catch: (error) => console.error(`Schedule for job ${job.id} failed:`, error) }, () =>
        this.fire(job.id),
      ),
    );
  }

  remove(jobId: number): void {
    this.timers.get(jobId)?.stop();
    this.timers.delete(jobId);
  }

  nextRun(jobId: number): string | null {
    return this.timers.get(jobId)?.nextRun()?.toISOString() ?? null;
  }

  stop(): void {
    for (const timer of this.timers.values()) timer.stop();
    this.timers.clear();
  }
}
