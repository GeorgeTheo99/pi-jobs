import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { open, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { AGENT_ID_PATTERN, AGENT_PRESETS, BUILTIN_AGENT_IDS, agentLabel, buildArgv, commandProgram, isBuiltinAgent, resolveExecutable, supportsSessions } from "./agents.ts";
import { applyAction, type CallApi } from "./actions.ts";
import { ChatBusyError, type ChatRunner } from "./chat.ts";
import type { Config } from "./config.ts";
import { FollowUpRefusedError, JobPausedError, QueueFullError, ShipRefusedError, isGitRepo, resolvesToCommit, type Runner } from "./runner.ts";
import { cronError, nextRuns, type Scheduler } from "./scheduler.ts";
import { resolveCheckout, scanCheckouts, type Checkout } from "./repos.ts";
import { ACTIVE_STATUSES, DEFAULT_RETRIES, MAX_RETRIES, TOKEN_PATTERN, TOKEN_RULE, type ApiToken, type Chat, type Job, type JobInput, type Settings, type Store } from "./store.ts";

/** Bumped on incompatible API changes; clients check it through /api/health. */
export const API_VERSION = 1;
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOG_TAIL = 64 * 1024;
const MAX_LOG_CHUNK = 256 * 1024;
const MAX_INSTRUCTIONS = 20_000;

class HttpError extends Error {
  readonly status: number;
  readonly fields?: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export interface AppDeps {
  config: Config;
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  chats: ChatRunner;
  env?: NodeJS.ProcessEnv;
}

type Handler = (req: IncomingMessage, params: string[], url: URL) => Promise<unknown>;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function createApp(deps: AppDeps) {
  const { config, store, runner, scheduler, chats } = deps;
  const envPath = (deps.env ?? process.env).PATH ?? "";
  const sessions = new WeakMap<IncomingMessage, ApiToken>();
  let checkoutCache: { at: number; checkouts: Promise<Checkout[]> } | null = null;
  const checkouts = () => {
    if (!checkoutCache || Date.now() - checkoutCache.at > 30_000) {
      checkoutCache = { at: Date.now(), checkouts: scanCheckouts(config.repoRoots) };
    }
    return checkoutCache.checkouts;
  };

  const jobView = (job: Job, latest = store.latestRuns().get(job.id) ?? null) => ({
    ...job,
    effectiveAgent: job.kind === "command" ? "command" : (job.agent ?? store.getSettings().defaultAgent),
    nextRunAt: scheduler.nextRun(job.id),
    lastRun: latest,
    webhookPath: `/api/hooks/${job.id}`,
  });

  const findJob = (id: string | undefined): Job => {
    const job = store.getJob(Number(id));
    if (!job) throw new HttpError(404, "Job not found");
    return job;
  };

  const settingsView = async (settings: Settings) => ({
    ...settings,
    agentInfo: await Promise.all(
      Object.entries(settings.agents).map(async ([id, { command }]) => {
        let executable: string | null = null;
        try {
          executable = await resolveExecutable(commandProgram(buildArgv(command, "")), envPath);
        } catch {
          // Invalid commands are reported as unavailable.
        }
        const builtin = isBuiltinAgent(id);
        return { id, label: agentLabel(id), builtin, preset: builtin ? AGENT_PRESETS[id].command : null, executable, sessions: supportsSessions(command) };
      }),
    ),
  });

  const findChat = (id: string | undefined): Chat => {
    const chat = store.getChat(Number(id));
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  };

  const chatView = (chat: Chat) => ({ ...chat, busy: chats.isBusy(chat.id), turns: store.chatTurns(chat.id) });

  const chatMessage = (body: Record<string, unknown>): string => {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new HttpError(400, "Fix the highlighted fields", { message: "Write a message" });
    if (message.length > MAX_INSTRUCTIONS) throw new HttpError(400, "Fix the highlighted fields", { message: `Keep it under ${MAX_INSTRUCTIONS} characters` });
    return message;
  };

  const sendMessage = (chat: Chat, message: string) => {
    try {
      chats.send(chat, message);
    } catch (error) {
      if (error instanceof ChatBusyError) throw new HttpError(409, error.message);
      throw error;
    }
    return chatView(store.getChat(chat.id)!);
  };

  /**
   * A chat action's API call, made in-process through the same routes (and so the same validation)
   * as a request from the UI.
   */
  const callApi: CallApi = async ({ method, path: pathname, body }) => {
    const url = new URL(pathname, "http://localhost");
    const route = routes.find(([m, pattern]) => m === method && pattern.test(url.pathname));
    if (!route || url.pathname.startsWith("/api/chats")) throw new HttpError(404, "Not found");
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method,
      url: pathname,
      headers: { "content-type": "application/json" },
    }) as unknown as IncomingMessage;
    return route[2](req, route[1].exec(url.pathname)!.slice(1), url);
  };

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true, apiVersion: API_VERSION, version: PACKAGE_VERSION })],
    ["GET", /^\/api\/session$/, async (req) => ({ token: sessions.get(req) })],
    ["GET", /^\/api\/tokens$/, async () => store.listTokens()],
    [
      "POST",
      /^\/api\/tokens$/,
      async (req) => {
        const body = await readJson(req);
        const name = String(body.name ?? "").trim();
        // Optional: the owner may choose the token itself; otherwise one is generated.
        const secret = typeof body.token === "string" && body.token !== "" ? body.token : undefined;
        const fields: Record<string, string> = {};
        if (!/^[\w .@-]{1,40}$/.test(name)) fields.name = "Use 1-40 letters, digits, spaces, or . @ - _";
        if (secret !== undefined && !TOKEN_PATTERN.test(secret)) fields.token = TOKEN_RULE;
        if (Object.keys(fields).length > 0) throw new HttpError(400, "Fix the highlighted fields", fields);
        if (store.listTokens().some((t) => t.name === name)) {
          throw new HttpError(409, "A token with that name exists", { name: "Choose another name" });
        }
        if (secret !== undefined && store.tokenInUse(secret)) {
          throw new HttpError(409, "That token is already in use", { token: "Choose another token" });
        }
        return store.createToken(name, secret);
      },
    ],
    [
      "DELETE",
      /^\/api\/tokens\/(\d+)$/,
      async (_req, [id]) => {
        if (!store.deleteToken(Number(id))) throw new HttpError(404, "Token not found");
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/api\/repos\/resolve$/,
      async (req) => {
        const body = await readJson(req);
        const remotes = Array.isArray(body.remotes) ? body.remotes.filter((r): r is string => typeof r === "string") : [];
        if (remotes.length === 0) throw new HttpError(400, "Send the checkout's remote URLs as remotes");
        const result = resolveCheckout(await checkouts(), remotes, typeof body.name === "string" ? body.name : undefined);
        if (result.status === "none") {
          throw new HttpError(404, `No checkout of this repository under ${config.repoRoots.join(", ")} on this server`);
        }
        if (result.status === "ambiguous") {
          throw new HttpError(409, `Several checkouts match: ${result.candidates.join(", ")}. Pass repoPath explicitly`);
        }
        return { path: result.path };
      },
    ],
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
        await Promise.all(
          runIds.flatMap((runId) => [rm(runner.logPath(runId), { force: true }), rm(runner.logPath(runId).replace(/\.log$/, ".payload"), { force: true })]),
        );
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/api\/jobs\/(\d+)\/run$/,
      async (_req, [id]) => startRun(findJob(id), "manual", null),
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
      "GET",
      /^\/api\/runs$/,
      async (_req, _params, url) => {
        const runs = store.listRuns({ jobId: intParam(url, "jobId"), limit: intParam(url, "limit") });
        const merged = await runner.mergedRuns(runs);
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
        const merged = await runner.mergedRuns([run]);
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
        const merged = await runner.mergedRuns(runs);
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
        const changes = await runner.changes(job, run, url.searchParams.get("since") === "base");
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
        try {
          const run = runner.approve(Number(id));
          if (!run) throw new HttpError(409, "This run isn't waiting for approval");
          return run;
        } catch (error) {
          if (error instanceof JobPausedError) throw new HttpError(409, error.message);
          throw error;
        }
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
        try {
          return runner.followUp(previous, instructions, body.mode === "ask" ? "ask" : "change");
        } catch (error) {
          if (error instanceof QueueFullError) throw new HttpError(429, error.message);
          if (error instanceof FollowUpRefusedError) throw new HttpError(409, error.message);
          throw error;
        }
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/ship$/,
      async (_req, [id]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        try {
          return await runner.ship(run);
        } catch (error) {
          if (error instanceof ShipRefusedError) throw new HttpError(409, error.message);
          if (error instanceof QueueFullError) throw new HttpError(429, error.message);
          throw error;
        }
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
    ["GET", /^\/api\/settings$/, async () => settingsView(store.getSettings())],
    [
      "PUT",
      /^\/api\/settings$/,
      async (req) => {
        const saved = store.saveSettings(validateSettings(await readJson(req), store.getSettings(), store.listJobs()));
        runner.pump();
        return settingsView(saved);
      },
    ],
    [
      "GET",
      /^\/api\/schedule-preview$/,
      async (_req, _params, url) => {
        const expression = url.searchParams.get("expression")?.trim() ?? "";
        const error = expression ? cronError(expression) : "Enter a cron expression";
        return error ? { valid: false, error, next: [] } : { valid: true, error: null, next: nextRuns(expression, 3) };
      },
    ],
    ["GET", /^\/api\/chats$/, async () => store.listChats().map((chat) => ({ ...chat, busy: chats.isBusy(chat.id), lastTurn: store.chatTurns(chat.id).at(-1) ?? null }))],
    [
      "POST",
      /^\/api\/chats$/,
      async (req) => {
        const body = await readJson(req);
        const message = chatMessage(body);
        const jobId = body.jobId == null ? null : findJob(String(body.jobId)).id;
        const runId = body.runId == null ? null : (store.getRun(Number(body.runId))?.id ?? null);
        if (body.runId != null && runId === null) throw new HttpError(404, "Run not found");
        const settings = store.getSettings();
        const agent = body.agent == null ? settings.defaultAgent : body.agent;
        if (typeof agent !== "string" || !Object.hasOwn(settings.agents, agent)) throw new HttpError(400, "Fix the highlighted fields", { agent: "Unknown agent" });
        const line = message.split("\n")[0]!.trim();
        const title = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
        const chat = store.createChat({ title, jobId, runId, agent, sessionId: randomUUID() });
        return sendMessage(chat, message);
      },
    ],
    ["GET", /^\/api\/chats\/(\d+)$/, async (_req, [id]) => chatView(findChat(id))],
    [
      "DELETE",
      /^\/api\/chats\/(\d+)$/,
      async (_req, [id]) => {
        const chat = findChat(id);
        if (chats.isBusy(chat.id)) throw new HttpError(409, "Stop the reply before deleting the chat");
        const turnIds = store.chatTurns(chat.id).map((turn) => turn.id);
        store.deleteChat(chat.id);
        await chats.deleteFiles(chat.id, turnIds);
        return { ok: true };
      },
    ],
    ["POST", /^\/api\/chats\/(\d+)\/messages$/, async (req, [id]) => sendMessage(findChat(id), chatMessage(await readJson(req)))],
    [
      "POST",
      /^\/api\/chats\/(\d+)\/cancel$/,
      async (_req, [id]) => {
        const chat = findChat(id);
        if (!chats.cancel(chat.id)) throw new HttpError(409, "No reply is being written");
        return chatView(chat);
      },
    ],
    [
      "GET",
      /^\/api\/chats\/(\d+)\/turns\/(\d+)\/log$/,
      async (_req, [id, turnId], url) => {
        const turn = store.getTurn(Number(turnId));
        if (!turn || turn.chatId !== findChat(id).id) throw new HttpError(404, "Turn not found");
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const { text, next, size } = await readChunk(chats.logPath(turn.id), offset);
        return { text, offset: next, size, done: turn.status !== "running" && next >= size };
      },
    ],
    [
      "POST",
      /^\/api\/chats\/(\d+)\/turns\/(\d+)\/actions\/(\d+)$/,
      async (req, [id, turnId, index]) => {
        const chat = findChat(id);
        const turn = store.getTurn(Number(turnId));
        if (!turn || turn.chatId !== chat.id) throw new HttpError(404, "Turn not found");
        const action = turn.actions[Number(index)];
        if (!action) throw new HttpError(404, "Action not found");
        const body = await readJson(req);
        if (body.decision !== "apply" && body.decision !== "dismiss") throw new HttpError(400, 'Send {"decision": "apply"} or {"decision": "dismiss"}');
        if (action.status !== "proposed") throw new HttpError(409, `This action was already ${action.status}`);
        const outcome = body.decision === "apply" ? await applyAction(action, store, callApi) : { action: { ...action, status: "dismissed" as const } };
        // Re-read: another action of the turn may have been decided meanwhile.
        const actions = store.getTurn(turn.id)!.actions.map((a, i) => (i === Number(index) ? outcome.action : a));
        store.updateTurn(turn.id, { actions });
        store.touchChat(chat.id);
        // A secret goes to the owner's card in this response only: it is never stored or shown to the agent.
        return { action: outcome.action, ...("secret" in outcome && outcome.secret ? { secret: outcome.secret } : {}) };
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
    try {
      const result = runner.trigger(job, trigger, payload);
      if ("skipped" in result) throw new HttpError(409, result.skipped);
      return result.run;
    } catch (error) {
      if (error instanceof QueueFullError) throw new HttpError(429, error.message);
      throw error;
    }
  }

  function checkRequest(req: IncomingMessage, pathname: string): void {
    // The coarse health probe is safe from any host, so the directory can check it over the LAN.
    if (req.method === "GET" && req.url === "/api/health") return;
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!config.allowedHosts.includes(hostname)) throw new HttpError(403, "Host not allowed");
    // Webhooks carry their job's own token; the UI shell is static. Everything else needs an API token.
    const isHook = pathname.startsWith("/api/hooks/");
    if (pathname.startsWith("/api/") && !isHook) {
      const secret = bearerToken(req);
      const token = secret ? store.authenticate(secret) : null;
      if (!token) throw new HttpError(401, "Sign in with an API token");
      sessions.set(req, token);
    }
    if (isHook || req.method === "GET" || req.method === "HEAD") return;
    // Browsers cannot send cross-origin JSON without a CORS preflight, which this server never grants.
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new HttpError(415, "Send requests as application/json");
    }
    const origin = req.headers.origin;
    if (origin && URL.parse(origin)?.host.toLowerCase() !== (req.headers.host ?? "").toLowerCase()) {
      throw new HttpError(403, "Cross-origin request rejected");
    }
  }

  async function serveStatic(req: IncomingMessage, pathname: string, res: ServerResponse): Promise<void> {
    const root = path.resolve(config.uiDir);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "Malformed URL");
    }
    const candidate = path.resolve(root, `.${decoded}`);
    let file = candidate.startsWith(root + path.sep) ? candidate : path.join(root, "index.html");
    try {
      if (!(await stat(file)).isFile()) file = path.join(root, "index.html");
    } catch {
      file = path.join(root, "index.html");
    }
    try {
      let data: Buffer | string = await readFile(file);
      const isAsset = file.includes(`${path.sep}assets${path.sep}`);
      const isIndex = path.basename(file) === "index.html";
      if (isIndex) data = data.toString("utf8").replace('<base href="/" />', `<base href="${proxyPrefix(req)}/" />`);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
        ...(isIndex && { vary: "X-Forwarded-Prefix" }),
      });
      res.end(data);
    } catch {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("The UI is not built. Run `npm run build` in the pi-jobs checkout.");
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const isApi = url.pathname.startsWith("/api/");
    try {
      checkRequest(req, url.pathname);
      if (!isApi) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
        await serveStatic(req, url.pathname, res);
        return;
      }
      const matches = routes.filter(([, pattern]) => pattern.test(url.pathname));
      if (matches.length === 0) throw new HttpError(404, "Not found");
      const route = matches.find(([method]) => method === req.method);
      if (!route) throw new HttpError(405, "Method not allowed");
      const params = route[1].exec(url.pathname)!.slice(1);
      const result = await route[2](req, params, url);
      const created = req.method === "POST" && (url.pathname === "/api/jobs" || url.pathname === "/api/tokens");
      const status = url.pathname.startsWith("/api/hooks/") ? 202 : created ? 201 : 200;
      sendJson(res, status, result);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, fields: error.fields });
      } else {
        console.error(error);
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  };
}

/** Builds a job from a request body; for an update, omitted catch-up and retry settings keep their values. */
async function validateJob(body: Record<string, unknown>, settings: Settings, existing: Job | null = null): Promise<JobInput> {
  const fields: Record<string, string> = {};
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

  const name = text("name");
  if (!name) fields.name = "Name is required";
  else if (name.length > 80) fields.name = "Keep the name under 80 characters";

  // A job's kind is fixed once created: its runs, items and fields mean different things.
  const kind = existing?.kind ?? (body.kind === undefined ? "agent" : body.kind);
  if (kind !== "agent" && kind !== "command") fields.kind = 'Use "agent" or "command"';
  else if (existing && body.kind !== undefined && body.kind !== existing.kind) fields.kind = "A job's kind can't be changed; create a new job";
  const isCommand = kind === "command";

  const repoPath = text("repoPath").replace(/^~(?=$|\/)/, os.homedir());
  if (isCommand) {
    if (!path.isAbsolute(repoPath)) fields.repoPath = "Use an absolute path to the directory to run in";
    else if (!(await stat(repoPath).then((s) => s.isDirectory(), () => false))) fields.repoPath = "Not a directory";
  } else if (!path.isAbsolute(repoPath)) fields.repoPath = "Use an absolute path to a git repository";
  else if (!(await isGitRepo(repoPath))) fields.repoPath = "Not a git repository";

  const baseRef = isCommand ? "" : text("baseRef") || "HEAD";
  if (!isCommand && !fields.repoPath && !(await resolvesToCommit(repoPath, baseRef))) {
    fields.baseRef = `"${baseRef}" does not resolve to a commit in this repository`;
  }

  const prompt = isCommand ? "" : text("prompt");
  if (!isCommand && !prompt) fields.prompt = "Tell the agent what to do";
  // Like the watch command: clients that leave it out (older ones) keep the job's.
  const command = isCommand ? (body.command === undefined ? (existing?.command ?? "") : text("command")) : null;
  if (isCommand && !command) fields.command = "Say what to run";
  if (!isCommand && text("command")) fields.command = "Only command jobs run a command";
  else if (command && command.length > 4000) fields.command = "Keep the command under 4,000 characters";
  if (isCommand) {
    // These belong to agent runs: a command job has no checkout to check, branch to push or result to release.
    const agentOnly = ["checkCommand", "watchCommand", "shipCommand", "releaseInstructions"] as const;
    for (const key of agentOnly) if (text(key)) fields[key] = "Command jobs don't use this";
    if (body.pushBranch === true) fields.pushBranch = "Command jobs don't use this";
    if (body.autoRelease === true) fields.autoRelease = "Command jobs don't use this";
    if (body.agent != null) fields.agent = "Command jobs don't use an agent";
  }

  const agent = isCommand ? null : (body.agent ?? null);
  // A job keeps an agent that was since removed from Settings until it is changed; its runs say so.
  if (agent !== null && (typeof agent !== "string" || (!Object.hasOwn(settings.agents, agent) && agent !== existing?.agent))) {
    fields.agent = `Choose one of ${Object.keys(settings.agents).join(", ")}, or the default`;
  }

  const schedule = text("schedule") || null;
  const scheduleError = schedule ? cronError(schedule) : null;
  if (scheduleError) fields.schedule = scheduleError;

  const timeoutMinutes = Number(body.timeoutMinutes ?? 30);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) {
    fields.timeoutMinutes = "Use a whole number of minutes from 1 to 1440";
  }

  // Clients from before watch commands leave them out; an update from one keeps the job's.
  const watchCommand = body.watchCommand === undefined ? (existing?.watchCommand ?? null) : text("watchCommand") || null;
  if (watchCommand && watchCommand.length > 4000) fields.watchCommand = "Keep the watch command under 4,000 characters";

  // Like the watch command: older clients leave it out, and their updates keep the job's.
  const shipCommand = body.shipCommand === undefined ? (existing?.shipCommand ?? null) : text("shipCommand") || null;
  if (shipCommand && shipCommand.length > 4000) fields.shipCommand = "Keep the ship command under 4,000 characters";

  // Like the ship command: older clients leave these out, and their updates keep the job's.
  const releaseInstructions =
    body.releaseInstructions === undefined ? (existing?.releaseInstructions ?? null) : text("releaseInstructions") || null;
  if (releaseInstructions && releaseInstructions.length > MAX_INSTRUCTIONS) {
    fields.releaseInstructions = `Keep the release instructions under ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters`;
  }
  if (releaseInstructions && shipCommand) {
    fields.releaseInstructions = "Use release instructions or a ship command, not both (the instructions can say to run the command)";
  }
  const autoRelease = typeof body.autoRelease === "boolean" ? body.autoRelease : (existing?.autoRelease ?? false);
  if (autoRelease && !releaseInstructions && !shipCommand) fields.autoRelease = "Add release instructions or a ship command first";

  const retries = Number(body.retries ?? existing?.retries ?? DEFAULT_RETRIES);
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    fields.retries = `Use a whole number from 0 to ${MAX_RETRIES}`;
  }

  if (Object.keys(fields).length > 0) throw new HttpError(400, "Fix the highlighted fields", fields);
  return {
    name,
    kind: kind as JobInput["kind"],
    repoPath,
    baseRef,
    prompt,
    command,
    agent: agent as JobInput["agent"],
    schedule,
    timeoutMinutes,
    checkCommand: text("checkCommand") || null,
    pushBranch: body.pushBranch === true,
    catchUp: typeof body.catchUp === "boolean" ? body.catchUp : (existing?.catchUp ?? true),
    retries,
    watchCommand,
    approveRuns: typeof body.approveRuns === "boolean" ? body.approveRuns : (existing?.approveRuns ?? false),
    shipCommand,
    releaseInstructions,
    autoRelease,
    enabled: body.enabled !== false,
  };
}

/**
 * Settings from a request body. The built-in agents are always there; others are added by naming them
 * and removed by leaving them out, unless a job still uses them.
 */
function validateSettings(body: Record<string, unknown>, current: Settings, jobs: Job[]): Settings {
  const fields: Record<string, string> = {};
  const agentsBody = body.agents && typeof body.agents === "object" && !Array.isArray(body.agents) ? (body.agents as Record<string, unknown>) : {};
  const agents: Settings["agents"] = {};
  const ids = [...BUILTIN_AGENT_IDS, ...Object.keys(agentsBody).filter((id) => !isBuiltinAgent(id))];
  for (const id of ids) {
    if (!AGENT_ID_PATTERN.test(id)) {
      fields[`agents.${id}`] = "Name it with lowercase letters, digits and dashes (up to 32), starting with a letter";
      continue;
    }
    const entry = agentsBody[id] as { command?: unknown } | undefined;
    const command = typeof entry?.command === "string" ? entry.command.trim() : "";
    try {
      buildArgv(command, "");
    } catch (error) {
      fields[`agents.${id}`] = error instanceof Error ? error.message : "Invalid command";
    }
    agents[id] = { command };
  }
  for (const job of jobs) {
    if (job.agent && Object.hasOwn(current.agents, job.agent) && !Object.hasOwn(agents, job.agent)) {
      fields[`agents.${job.agent}`] = `Job #${job.id} "${job.name}" uses this agent; change its agent first`;
    }
  }
  if (typeof body.defaultAgent !== "string" || !Object.hasOwn(agents, body.defaultAgent)) fields.defaultAgent = "Choose one of the agents";
  const maxConcurrent = Number(body.maxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    fields.maxConcurrent = "Use a whole number from 1 to 8";
  }
  if (Object.keys(fields).length > 0) throw new HttpError(400, "Fix the highlighted fields", fields);
  return { defaultAgent: body.defaultAgent as string, agents, maxConcurrent };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A report's "Verdict: …" line, which the triage prompt asks for, so lists can show the verdict without the report. */
export function summaryVerdict(summary: string | null): string | null {
  const line = summary?.split("\n").find((l) => /^\W*verdict\W*:/i.test(l.replace(/\*\*|__|`/g, "").trim()));
  return line ? line.trim().slice(0, 300) : null;
}

/** The first line of an agent's report, without Markdown emphasis or heading marks, for lists. */
export function summaryHeadline(summary: string | null): string | null {
  const line = summary
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[-=*_`]{3,}$/.test(l));
  if (!line) return null;
  const plain = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain || null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse((await readBody(req)) || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
  throw new HttpError(400, "Expected a JSON object");
}

async function readChunk(file: string, offset: number) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return { text: "", next: 0, size: 0 };
  }
  try {
    const { size } = await handle.stat();
    const start = Math.min(offset, size);
    const length = Math.min(size - start, MAX_LOG_CHUNK);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    // Stop at the last complete line so multi-byte characters are never split.
    const end = start + length < size ? buffer.lastIndexOf(0x0a) + 1 || length : length;
    return { text: buffer.subarray(0, end).toString("utf8"), next: start + end, size };
  } finally {
    await handle.close();
  }
}

/** The path prefix a reverse proxy mounted the app under, e.g. "/pi-jobs"; "" when served directly. */
function proxyPrefix(req: IncomingMessage): string {
  const value = req.headers["x-forwarded-prefix"];
  // Restrictive charset: the value is written into HTML.
  return typeof value === "string" && /^(\/[A-Za-z0-9._-]+)+$/.test(value) ? value : "";
}

function intParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new HttpError(400, `${name} must be an integer`);
  return number;
}

function prettyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const custom = req.headers["x-pi-jobs-token"];
  return typeof custom === "string" ? custom : null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
