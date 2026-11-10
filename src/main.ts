import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Runner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

const config = loadConfig();
const store = new Store(path.join(config.stateDir, "pi-jobs.db"));
const runner = new Runner({ store, stateDir: config.stateDir });

const interrupted = store.failInterruptedRuns();
if (interrupted > 0) console.warn(`Marked ${interrupted} interrupted run(s) as failed`);

const scheduler = new Scheduler((jobId) => {
  const job = store.getJob(jobId);
  if (!job) return;
  try {
    const result = runner.trigger(job, "schedule");
    if ("skipped" in result) console.log(`Skipped scheduled run of "${job.name}": ${result.skipped}`);
  } catch (error) {
    console.error(`Scheduled run of "${job.name}" failed to queue:`, error);
  }
});
for (const job of store.listJobs()) scheduler.sync(job);
runner.pump();

const handle = createApp({ config, store, runner, scheduler });
const server = createServer((req, res) => void handle(req, res));
server.listen(config.port, config.host, () => {
  console.log(`pi-jobs listening on http://${config.host}:${config.port} (state: ${config.stateDir})`);
});

const shutdown = async () => {
  scheduler.stop();
  server.close();
  await runner.shutdown();
  store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
