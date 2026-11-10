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

/** A fire later than this after its due time (the machine was asleep, say) counts as missed. */
export const LATE_FIRE_MS = 2 * 60_000;

/**
 * Keeps one in-process cron timer per enabled, scheduled job. A fire that comes late, after the
 * machine slept through its time, reaches `fire` with `missed` set; several fires slept through
 * arrive as one. Fires due while the server was down are found at startup by `missed()`.
 */
export class Scheduler {
  private readonly timers = new Map<number, { cron: Cron; due: Date | null }>();
  private readonly fire: (jobId: number, missed: boolean) => void;

  constructor(fire: (jobId: number, missed: boolean) => void) {
    this.fire = fire;
  }

  sync(job: Job): void {
    this.remove(job.id);
    if (!job.enabled || !job.schedule) return;
    const cron = new Cron(
      job.schedule,
      { protect: true, catch: (error) => console.error(`Schedule for job ${job.id} failed:`, error) },
      () => {
        const now = new Date();
        const missed = entry.due !== null && now.getTime() - entry.due.getTime() > LATE_FIRE_MS;
        entry.due = cron.nextRun(now);
        this.fire(job.id, missed);
      },
    );
    const entry = { cron, due: cron.nextRun() };
    this.timers.set(job.id, entry);
  }

  /** Whether a fire of the job's schedule came due since it last fired (or was last saved). */
  missed(job: Job, now = new Date()): boolean {
    if (!job.enabled || !job.schedule) return false;
    const since = [job.lastFiredAt, job.updatedAt].filter((t) => t !== null).sort().at(-1)!;
    const cron = new Cron(job.schedule, { paused: true });
    const due = cron.nextRun(new Date(since));
    cron.stop();
    return due !== null && due <= now;
  }

  remove(jobId: number): void {
    this.timers.get(jobId)?.cron.stop();
    this.timers.delete(jobId);
  }

  nextRun(jobId: number): string | null {
    return this.timers.get(jobId)?.cron.nextRun()?.toISOString() ?? null;
  }

  stop(): void {
    for (const { cron } of this.timers.values()) cron.stop();
    this.timers.clear();
  }
}
