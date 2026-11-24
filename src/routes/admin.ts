import { readFileSync } from "node:fs";
import { cronError, nextRuns } from "../scheduler.ts";
import { resolveCheckout } from "../repos.ts";
import { HttpError, readJson } from "../http.ts";
import { TOKEN_PATTERN, TOKEN_RULE } from "../store.ts";
import { validateSettings } from "../validate.ts";
import type { AppContext, Route } from "./context.ts";

/** Bumped on incompatible API changes; clients check it through /api/health. */
export const API_VERSION = 1;
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

export function adminRoutes(ctx: AppContext): Route[] {
  const { config, store, runner, sessions, checkouts, settingsView } = ctx;
  return [
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
  ];
}
