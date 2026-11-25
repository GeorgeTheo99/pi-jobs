import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "./app.ts";
import { ChatRunner } from "./chat.ts";
import { loadConfig } from "./config.ts";
import { Notifier, finishedNotification } from "./notify.ts";
import { summarizePayload } from "./report.ts";
import { Runner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

const config = loadConfig();
const store = new Store(path.join(config.stateDir, "pi-jobs.db"));
const runner = new Runner({ store, stateDir: config.stateDir });
const notifier = new Notifier(store, config);
runner.on("finished", (run, { retrying }) => {
  const notification = finishedNotification(run, store.getJob(run.jobId), retrying);
  if (notification) void notifier.send(notification);
});
runner.on("awaiting", (runs) => {
  const job = store.getJob(runs[0]!.jobId);
  const first = runs[0]!;
  void notifier.send(
    runs.length === 1
      ? {
          event: "approval",
          title: `New: ${summarizePayload(first.payload) ?? job?.name ?? `run #${first.id}`}`,
          message: `${job?.name ?? "A job"} has a run waiting for your approval.`,
          path: `/runs/${first.id}`,
          jobId: first.jobId,
          runId: first.id,
        }
      : {
          event: "approval",
          title: `${runs.length} new: ${job?.name ?? "a job"}`,
          message: runs.map((run) => summarizePayload(run.payload) ?? `run #${run.id}`).join("; ").slice(0, 300),
          path: "/",
          jobId: first.jobId,
        },
  );
});
runner.on("autoReleaseFailed", (run, error) => {
  void notifier.send({ event: "review", title: `Ready to review (not released automatically): ${store.getJob(run.jobId)?.name ?? `job #${run.jobId}`}`, message: error.slice(0, 300), path: `/runs/${run.id}`, jobId: run.jobId, runId: run.id });
});
runner.on("watchFailed", (job, error) => {
  void notifier.send({ event: "watch_failed", title: `Watch failing: ${job.name}`, message: error.slice(0, 300), path: `/jobs/${job.id}`, jobId: job.id });
});

const interrupted = store.failInterruptedRuns();
if (interrupted.length > 0) console.warn(`Marked ${interrupted.length} interrupted run(s) as failed`);
for (const run of interrupted) runner.retry(run);
// A release the stop cut off needs the owner: it may have gone out.
for (const run of interrupted.filter((r) => r.mode === "release" || r.mode === "ship")) {
  const what = run.stage === "production" ? "promotion" : run.stage === "staging" ? "staging release" : "release";
  void notifier.send({ event: "release_failed", title: `${what[0]!.toUpperCase()}${what.slice(1)} interrupted: ${store.getJob(run.jobId)?.name ?? `job #${run.jobId}`}`, message: `The server stopped during the ${what}. Check whether it went out before trying again.`, path: `/runs/${run.id}`, jobId: run.jobId, runId: run.id });
}
// Releases cut off by this stop, or a graceful one in the last day, may have gone out anyway.
void runner.recheckInterruptedReleases(new Date(Date.now() - 24 * 60 * 60_000).toISOString()).catch((error) => {
  console.error("Could not recheck interrupted releases:", error);
});
runner.backfillSummaries();
const cutOff = store.failInterruptedTurns();
if (cutOff.length > 0) console.warn(`Marked ${cutOff.length} interrupted chat repl${cutOff.length === 1 ? "y" : "ies"} as failed`);

const fireSchedule = (jobId: number, missed: boolean) => {
  const job = store.getJob(jobId);
  if (!job) return;
  try {
    const result = runner.fireSchedule(job, missed);
    if ("skipped" in result) console.log(`Skipped scheduled run of "${job.name}": ${result.skipped}`);
    else if ("watch" in result) {
      void result.watch.then(({ runs, error }) => {
        if (runs.length > 0) console.log(`Watch of "${job.name}" started run(s) ${runs.map((run) => `#${run.id}`).join(", ")}`);
        if (error) console.warn(`Watch of "${job.name}": ${error}`);
      });
    } else if (missed) console.log(`Caught up a missed scheduled run of "${job.name}" (run #${result.run.id})`);
  } catch (error) {
    console.error(`Scheduled run of "${job.name}" failed to queue:`, error);
  }
};
const scheduler = new Scheduler(fireSchedule);
for (const job of store.listJobs()) {
  scheduler.sync(job);
  if (scheduler.missed(job)) fireSchedule(job.id, true);
}
runner.pump();

const chats = new ChatRunner({ store, stateDir: config.stateDir, nextRun: (jobId) => scheduler.nextRun(jobId) });
const handle = createApp({ config, store, runner, scheduler, chats, notifier });
const server = createServer((req, res) => void handle(req, res));
server.listen(config.port, config.host, () => {
  console.log(`pi-jobs listening on http://${config.host}:${config.port} (state: ${config.stateDir})`);
});

const shutdown = async () => {
  scheduler.stop();
  server.close();
  await Promise.all([runner.shutdown(), chats.shutdown()]);
  store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
