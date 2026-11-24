import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import type { CallApi } from "./actions.ts";
import { ChatBusyError, type ChatRunner } from "./chat.ts";
import type { Config } from "./config.ts";
import type { Notifier } from "./notify.ts";
import { HttpError, bearerToken, proxyPrefix, sendJson } from "./http.ts";
import { JobPausedError, QueueFullError, ReleaseRefusedError, type Runner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Store } from "./store.ts";
import { adminRoutes } from "./routes/admin.ts";
import { chatRoutes } from "./routes/chats.ts";
import { createContext, type Route } from "./routes/context.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { runRoutes } from "./routes/runs.ts";

export { API_VERSION } from "./routes/admin.ts";

export interface AppDeps {
  config: Config;
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  chats: ChatRunner;
  /** Sends Settings' notifications (a test one from Settings). */
  notifier?: Notifier;
  env?: NodeJS.ProcessEnv;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** The HTTP status for errors the runner and chats raise: a full queue, or a request that doesn't fit the current state. */
function domainStatus(error: unknown): number | null {
  if (error instanceof QueueFullError) return 429;
  if (error instanceof ReleaseRefusedError || error instanceof JobPausedError || error instanceof ChatBusyError) return 409;
  return null;
}

export function createApp(deps: AppDeps) {
  const { config, store } = deps;
  const ctx = createContext(deps, (deps.env ?? process.env).PATH ?? "");
  const { sessions } = ctx;
  const routes: Route[] = [...adminRoutes(ctx), ...jobRoutes(ctx), ...runRoutes(ctx), ...chatRoutes(ctx)];

  /**
   * A chat action's API call, made in-process through the same routes (and so the same validation and
   * error statuses) as a request from the UI.
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
    try {
      return await route[2](req, route[1].exec(url.pathname)!.slice(1), url);
    } catch (error) {
      const status = domainStatus(error);
      throw status ? new HttpError(status, (error as Error).message) : error;
    }
  };
  ctx.callApi = callApi;

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
      const status = error instanceof HttpError ? error.status : domainStatus(error);
      if (status !== null) {
        sendJson(res, status, { error: (error as Error).message, fields: error instanceof HttpError ? error.fields : undefined });
      } else {
        console.error(error);
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  };
}
