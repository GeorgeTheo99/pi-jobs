import { rm } from "node:fs/promises";
import { HttpError, bearerToken, newToken, prettyPayload, readBody, readJson, safeEqual } from "../http.ts";
import { ACTIVE_STATUSES, type Job } from "../store.ts";
import { validateJob } from "../validate.ts";
import type { AppContext, Route } from "./context.ts";

export function jobRoutes(ctx: AppContext): Route[] {
  const { store, runner, scheduler, findJob, jobView } = ctx;
  return [
    [
      "GET",
      /^\/api\/jobs$/,
      async () => {
        const latest = store.latestRuns();
        return store.listJobs().map((job) => jobView(job, latest.get(job.id) ?? null));
      },
    ],
    [
      "POST",
      /^\/api\/jobs$/,
      async (req) => {
        const body = await readJson(req);
        const input = await validateJob(body, store.getSettings());
        const job = store.createJob(input, body.webhookEnabled === true ? newToken() : null);
        scheduler.sync(job);
        return jobView(job);
      },
    ],
    ["GET", /^\/api\/jobs\/(\d+)$/, async (_req, [id]) => jobView(findJob(id))],
    [
      "PUT",
      /^\/api\/jobs\/(\d+)$/,
      async (req, [id]) => {
        const existing = findJob(id);
        const body = await readJson(req);
        const input = await validateJob(body, store.getSettings(), existing);
        const token =
          body.webhookEnabled === undefined
            ? existing.webhookToken
            : body.webhookEnabled === true
              ? (existing.webhookToken ?? newToken())
              : null;
        const job = store.updateJob(existing.id, input, token)!;
        scheduler.sync(job);
        return jobView(job);
      },
    ],
    [
      "PATCH",
      /^\/api\/jobs\/(\d+)$/,
      async (req, [id]) => {
        const existing = findJob(id);
        const body = await readJson(req);
        const input = await validateJob(body, store.getSettings(), existing);
        const token =
          body.webhookEnabled === undefined
            ? existing.webhookToken
            : body.webhookEnabled === true
              ? (existing.webhookToken ?? newToken())
              : null;
        const job = store.updateJob(existing.id, input, token)!;
        scheduler.sync(job);
        return jobView(job);
      },
    ],
    [
      "DELETE",
      /^\/api\/jobs\/(\d+)$/,
      async (_req, [id]) => {
        const job = findJob(id);
        if (store.countRuns(job.id, ACTIVE_STATUSES) > 0) {
          throw new HttpError(409, "Cancel or dismiss this job's waiting, queued and running runs before deleting it");
        }
        const runIds = store.runIdsForJob(job.id);
        scheduler.remove(job.id);
        store.deleteJob(job.id);
        await Promise.all(runIds.map((runId) => rm(runner.logPath(runId), { force: true })));
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/api\/jobs\/(\d+)\/run$/,
      async (req, [id]) => {
        const run = startRun(findJob(id), "manual", null);
        return store.updateRun(run.id, { requestedBy: ctx.sessions.get(req)?.name ?? null });
      },
    ],
    [
      "POST",
      /^\/api\/jobs\/(\d+)\/watch$/,
      async (_req, [id]) => {
        const job = findJob(id);
        if (!job.watchCommand) throw new HttpError(409, "This job has no watch command");
        if (!job.enabled) throw new HttpError(409, "Job is paused");
        return runner.watch(job);
      },
    ],
    [
      "POST",
      /^\/api\/jobs\/(\d+)\/webhook-token$/,
      async (_req, [id]) => {
        const job = findJob(id);
        if (!job.webhookToken) throw new HttpError(409, "The webhook trigger is off for this job");
        return jobView(store.updateJob(job.id, job, newToken())!);
      },
    ],
    [
      "POST",
      /^\/api\/hooks\/(\d+)$/,
      async (req, [id], url) => {
        const job = store.getJob(Number(id));
        const supplied = bearerToken(req) ?? url.searchParams.get("token");
        if (!job?.webhookToken || !supplied || !safeEqual(supplied, job.webhookToken)) {
          throw new HttpError(401, "Unknown job or invalid token");
        }
        if (!job.enabled) throw new HttpError(409, "Job is paused");
        const raw = (await readBody(req)).trim();
        return startRun(job, "webhook", raw ? prettyPayload(raw) : null);
      },
    ],
  ];

  function startRun(job: Job, trigger: "manual" | "webhook", payload: string | null) {
    const result = runner.trigger(job, trigger, payload);
    if ("skipped" in result) throw new HttpError(409, result.skipped);
    return result.run;
  }
}
