import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { AGENT_IDS, AGENT_PRESETS, buildArgv, commandProgram, isAgentId, resolveExecutable } from "./agents.ts";
import type { Config } from "./config.ts";
import { QueueFullError, isGitRepo, resolvesToCommit, type Runner } from "./runner.ts";
import { cronError, nextRuns, type Scheduler } from "./scheduler.ts";
import { resolveCheckout, scanCheckouts, type Checkout } from "./repos.ts";
import { ACTIVE_STATUSES, DEFAULT_RETRIES, MAX_RETRIES, type ApiToken, type Job, type JobInput, type Settings, type Store } from "./store.ts";

/** Bumped on incompatible API changes; clients check it through /api/health. */
export const API_VERSION = 1;
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOG_TAIL = 64 * 1024;
const MAX_LOG_CHUNK = 256 * 1024;

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
  const { config, store, runner, scheduler } = deps;
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
    effectiveAgent: job.agent ?? store.getSettings().defaultAgent,
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
      AGENT_IDS.map(async (id) => {
        let executable: string | null = null;
        try {
          executable = await resolveExecutable(commandProgram(buildArgv(settings.agents[id].command, "")), envPath);
        } catch {
          // Invalid commands are reported as unavailable.
        }
        return { id, label: AGENT_PRESETS[id].label, preset: AGENT_PRESETS[id].command, executable };
      }),
    ),
  });

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true, apiVersion: API_VERSION, version: PACKAGE_VERSION })],
    ["GET", /^\/api\/session$/, async (req) => ({ token: sessions.get(req) })],
    ["GET", /^\/api\/tokens$/, async () => store.listTokens()],
    [
      "POST",
      /^\/api\/tokens$/,
      async (req) => {
        const name = String((await readJson(req)).name ?? "").trim();
        if (!/^[\w .@-]{1,40}$/.test(name)) {
          throw new HttpError(400, "Fix the highlighted fields", { name: "Use 1-40 letters, digits, spaces, or . @ - _" });
        }
        if (store.listTokens().some((t) => t.name === name)) {
          throw new HttpError(409, "A token with that name exists", { name: "Choose another name" });
        }
        return store.createToken(name);
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
        const input = await validateJob(body);
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
        const input = await validateJob(body, existing);
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
          throw new HttpError(409, "Cancel this job's queued and running runs before deleting it");
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
      async (_req, [id]) => startRun(findJob(id), "manual", null),
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
        return store.listRuns({ jobId: intParam(url, "jobId"), limit: intParam(url, "limit") });
      },
    ],
    [
      "GET",
      /^\/api\/runs\/(\d+)$/,
      async (_req, [id]) => {
        const run = store.getRun(Number(id));
        if (!run) throw new HttpError(404, "Run not found");
        return run;
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
        const saved = store.saveSettings(validateSettings(await readJson(req)));
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
async function validateJob(body: Record<string, unknown>, existing: Job | null = null): Promise<JobInput> {
  const fields: Record<string, string> = {};
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

  const name = text("name");
  if (!name) fields.name = "Name is required";
  else if (name.length > 80) fields.name = "Keep the name under 80 characters";

  const repoPath = text("repoPath").replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(repoPath)) fields.repoPath = "Use an absolute path to a git repository";
  else if (!(await isGitRepo(repoPath))) fields.repoPath = "Not a git repository";

  const baseRef = text("baseRef") || "HEAD";
  if (!fields.repoPath && !(await resolvesToCommit(repoPath, baseRef))) {
    fields.baseRef = `"${baseRef}" does not resolve to a commit in this repository`;
  }

  const prompt = text("prompt");
  if (!prompt) fields.prompt = "Tell the agent what to do";

  const agent = body.agent ?? null;
  if (agent !== null && !isAgentId(agent)) fields.agent = "Unknown agent";

  const schedule = text("schedule") || null;
  const scheduleError = schedule ? cronError(schedule) : null;
  if (scheduleError) fields.schedule = scheduleError;

  const timeoutMinutes = Number(body.timeoutMinutes ?? 30);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) {
    fields.timeoutMinutes = "Use a whole number of minutes from 1 to 1440";
  }

  const retries = Number(body.retries ?? existing?.retries ?? DEFAULT_RETRIES);
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    fields.retries = `Use a whole number from 0 to ${MAX_RETRIES}`;
  }

  if (Object.keys(fields).length > 0) throw new HttpError(400, "Fix the highlighted fields", fields);
  return {
    name,
    repoPath,
    baseRef,
    prompt,
    agent: agent as JobInput["agent"],
    schedule,
    timeoutMinutes,
    checkCommand: text("checkCommand") || null,
    pushBranch: body.pushBranch === true,
    catchUp: typeof body.catchUp === "boolean" ? body.catchUp : (existing?.catchUp ?? true),
    retries,
    enabled: body.enabled !== false,
  };
}

function validateSettings(body: Record<string, unknown>): Settings {
  const fields: Record<string, string> = {};
  if (!isAgentId(body.defaultAgent)) fields.defaultAgent = "Choose Pi, Claude Code, or Codex";
  const agentsBody = (body.agents ?? {}) as Record<string, { command?: unknown } | undefined>;
  const agents = {} as Settings["agents"];
  for (const id of AGENT_IDS) {
    const command = typeof agentsBody[id]?.command === "string" ? (agentsBody[id]!.command as string).trim() : "";
    try {
      buildArgv(command, "");
    } catch (error) {
      fields[`agents.${id}`] = error instanceof Error ? error.message : "Invalid command";
    }
    agents[id] = { command };
  }
  const maxConcurrent = Number(body.maxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    fields.maxConcurrent = "Use a whole number from 1 to 8";
  }
  if (Object.keys(fields).length > 0) throw new HttpError(400, "Fix the highlighted fields", fields);
  return { defaultAgent: body.defaultAgent as Settings["defaultAgent"], agents, maxConcurrent };
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
