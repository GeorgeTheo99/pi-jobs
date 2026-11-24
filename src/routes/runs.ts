import { stat } from "node:fs/promises";
import { HttpError, intParam, readChunk, readJson } from "../http.ts";
import { summaryHeadline, summaryVerdict } from "../report.ts";
import { ACTIVE_STATUSES } from "../store.ts";
import { MAX_INSTRUCTIONS } from "../validate.ts";
import type { AppContext, Route } from "./context.ts";

const MAX_LOG_TAIL = 64 * 1024;

export function runRoutes(ctx: AppContext): Route[] {
  const { store, runner, findJob } = ctx;
  return [
    [
      "GET",
      /^\/api\/runs$/,
      async (_req, _params, url) => {
        const runs = store.listRuns({ jobId: intParam(url, "jobId"), limit: intParam(url, "limit") });
        const merged = await runner.repos.mergedRuns(runs);
        // Lists carry the first line of each summary, not the whole report.
        return runs.map(({ summary, ...run }) => ({
          ...run,
          summaryHeadline: summaryHeadline(summary),
          summaryVerdict: summaryVerdict(summary),
          merged: merged.has(run.id),
        }));
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)$/,
      async (_req, [id]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        const merged = await runner.repos.mergedRuns([run]);
        return { ...run, summaryHeadline: summaryHeadline(run.summary), merged: merged.has(run.id) };
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)\/thread$/,
      async (_req, [id]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        // Every run of the item, oldest first, with their reports: the item's conversation.
        const runs = store.itemRuns(run.itemId);
        const merged = await runner.repos.mergedRuns(runs);
        return runs.map((r) => ({
          ...r,
          summaryHeadline: summaryHeadline(r.summary),
          summaryVerdict: summaryVerdict(r.summary),
          merged: merged.has(r.id),
        }));
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)\/changes$/,
      async (_req, [id], url) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        const job = findJob(String(run.jobId));
        const changes = await runner.repos.changes(job, run, url.searchParams.get("since") === "base");
        if (!changes) throw new HttpError(404, "This run left no commits to show");
        return changes;
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)\/log$/,
      async (_req, [id], url) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        const tail = intParam(url, "tail");
        let offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        if (tail !== undefined) {
          const size = (await stat(runner.logPath(run.id)).catch(() => ({ size: 0 }))).size;
          offset = Math.max(0, size - Math.min(Math.max(tail, 0), MAX_LOG_TAIL));
        }
        const { text, next, size } = await readChunk(runner.logPath(run.id), offset);
        return { text, offset: next, size, done: !ACTIVE_STATUSES.includes(run.status) && next >= size };
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/approve$/,
      async (_req, [id]) => {
        if (!store.getRun(Number(id))) throw new HttpError(404, "Run not found");
        const run = runner.approve(Number(id));
        if (!run) throw new HttpError(409, "This run isn't waiting for approval");
        return run;
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/(replied|closed)$/,
      async (req, [id, mark]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        if (ACTIVE_STATUSES.includes(run.status)) throw new HttpError(409, "Wait for the run to finish");
        const body = await readJson(req);
        if (typeof body.value !== "boolean") throw new HttpError(400, "Send {\"value\": true} or {\"value\": false}");
        const at = body.value ? new Date().toISOString() : null;
        return store.updateRun(run.id, mark === "replied" ? { repliedAt: at } : { closedAt: at });
      },
    ],
    [
      "POST",
      /^\/api\/watches\/check$/,
      async () => {
        const jobs = store.listJobs().filter((job) => job.enabled && job.watchCommand);
        const results = [];
        for (const job of jobs) {
          const result = await runner.watch(job);
          results.push({ jobId: job.id, started: result.runs.length, error: result.error });
        }
        return results;
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/follow-up$/,
      async (req, [id]) => {
        const previous = store.getRun(Number(id));
        if (!previous) throw new HttpError(404, "Run not found");
        if (ACTIVE_STATUSES.includes(previous.status)) throw new HttpError(409, "Follow up on a run once it has finished");
        const body = await readJson(req);
        const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
        if (!instructions) throw new HttpError(400, "Fix the highlighted fields", { instructions: "Say what the agent should do" });
        if (instructions.length > MAX_INSTRUCTIONS) {
          throw new HttpError(400, "Fix the highlighted fields", { instructions: `Keep it under ${MAX_INSTRUCTIONS} characters` });
        }
        if (body.mode !== undefined && body.mode !== "ask" && body.mode !== "change") {
          throw new HttpError(400, "Fix the highlighted fields", { mode: 'Use "ask" or "change"' });
        }
        return runner.followUp(previous, instructions, body.mode === "ask" ? "ask" : "change");
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/(?:release|ship)$/,
      async (_req, [id]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        return runner.release(run);
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/cancel$/,
      async (_req, [id]) => {
        const run = runner.cancel(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        return run;
      },
    ],
  ];
}
