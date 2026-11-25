import { stat } from "node:fs/promises";
import { HttpError, intParam, readChunk, readJson } from "../http.ts";
import { WAITING_STATES, itemView, listRunView, runView } from "../items.ts";
import { ACTIVE_STATUSES, type Run } from "../store.ts";
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
        return runs.map((run) => listRunView(run, merged.has(run.id)));
      },
    ],
    [
      "GET",
      /^\/api\/items$/,
      async (_req, _params, url) => {
        // Newest activity first. ?waiting=1 keeps only items waiting on the owner; without it, items
        // waiting on the owner come too even when they are older than the newest `limit`, so the
        // Inbox never loses one. Both look at the newest 500 items.
        const limit = Math.min(Math.max(intParam(url, "limit") ?? 100, 1), 500);
        const ids = store.itemIds({ jobId: intParam(url, "jobId"), limit: 500 });
        const runs = store.runsOfItems(ids);
        const merged = await runner.repos.mergedRuns(runs);
        const byItem = new Map<number, ReturnType<typeof listRunView>[]>();
        for (const run of runs) byItem.set(run.itemId, [...(byItem.get(run.itemId) ?? []), listRunView(run, merged.has(run.id))]);
        const items = ids.flatMap((id) => {
          const itemRuns = byItem.get(id);
          return itemRuns ? [itemView(itemRuns, store.getJob(itemRuns[0]!.jobId))] : [];
        });
        const waiting = (item: (typeof items)[number]) => WAITING_STATES.includes(item.state);
        if (url.searchParams.get("waiting") === "1") return items.filter(waiting);
        return items.filter((item, index) => index < limit || waiting(item));
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)$/,
      async (_req, [id]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        const merged = await runner.repos.mergedRuns([run]);
        return runView(run, merged.has(run.id));
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)\/thread$/,
      async (_req, [id]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        // Every run of the item, oldest first, with their reports: the item's conversation.
        return (await itemOf(run)).runs;
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)\/release-preview$/,
      async (_req, [id]) => {
        const preview = await runner.releasePreview(ctx.findRun(id)).catch((error: Error) => {
          throw new HttpError(409, error.message);
        });
        if (!preview) throw new HttpError(404, "This item has no changes to release");
        return preview;
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)\/promote-preview$/,
      async (_req, [id]) => {
        const preview = await runner.promotePreview(ctx.findRun(id));
        if (!preview) throw new HttpError(404, "This item has nothing staged to promote");
        return preview;
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)\/item$/,
      async (_req, [id]) => itemOf(ctx.findRun(id)),
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
      async (req, [id]) => {
        if (!store.getRun(Number(id))) throw new HttpError(404, "Run not found");
        const run = runner.approve(Number(id), ctx.sessions.get(req)?.name);
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
        const run = runner.followUp(previous, instructions, body.mode === "ask" ? "ask" : "change");
        return store.updateRun(run.id, { requestedBy: ctx.sessions.get(req)?.name ?? null });
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/(?:release|ship)$/,
      async (req, [id]) => {
        const run = ctx.findRun(id);
        // The head the owner reviewed (optional, for older clients): releasing refuses if the item moved on.
        const body = await readJson(req);
        if (body.expectedHead !== undefined && (typeof body.expectedHead !== "string" || !/^[0-9a-f]{40}$/.test(body.expectedHead))) {
          throw new HttpError(400, "expectedHead must be a full commit id");
        }
        return runner.release(run, { expectedHead: body.expectedHead as string | undefined, requestedBy: ctx.sessions.get(req)?.name });
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/promote$/,
      async (req, [id]) => {
        const run = ctx.findRun(id);
        // The staged commit the owner reviewed (optional): promoting refuses if it changed.
        const body = await readJson(req);
        if (body.expectedHead !== undefined && (typeof body.expectedHead !== "string" || !/^[0-9a-f]{40}$/.test(body.expectedHead))) {
          throw new HttpError(400, "expectedHead must be a full commit id");
        }
        return runner.promote(run, { expectedHead: body.expectedHead as string | undefined, requestedBy: ctx.sessions.get(req)?.name });
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

  /** A run's item, with every run's full report. */
  async function itemOf(run: Run) {
    const runs = store.itemRuns(run.itemId);
    const merged = await runner.repos.mergedRuns(runs);
    return itemView(
      runs.map((r) => runView(r, merged.has(r.id))),
      store.getJob(run.jobId),
    );
  }
}
