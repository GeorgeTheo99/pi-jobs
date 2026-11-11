import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Run } from "../src/store.ts";
import { git, setup, waitForFinish } from "./helpers.ts";

async function startApp(t: TestContext) {
  const ctx = setup();
  const config = { ...loadConfig({}), stateDir: path.join(ctx.root, "state"), uiDir: path.join(ctx.root, "no-ui"), repoRoots: [ctx.root] };
  const scheduler = new Scheduler(() => {});
  const server = createServer(createApp({ config, store: ctx.store, runner: ctx.runner, scheduler }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const { secret } = ctx.store.createToken("test");
  t.after(async () => {
    scheduler.stop();
    server.close();
    await ctx.cleanup();
  });

  const call = (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: pathname,
          headers: {
            authorization: `Bearer ${secret}`,
            ...(data !== undefined && { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) }),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  return { ...ctx, call, scheduler, secret };
}

test("jobs can be created, listed, updated and deleted", async (t) => {
  const app = await startApp(t);
  const created = await app.call("POST", "/api/jobs", {
    name: "Gateway models",
    repoPath: app.repo,
    baseRef: "main",
    prompt: "Check for new models",
    schedule: "0 6 * * *",
    webhookEnabled: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.effectiveAgent, "pi");
  assert.ok(created.json.nextRunAt);
  assert.match(created.json.webhookToken, /^[\w-]{32}$/);
  assert.equal(created.json.catchUp, true, "catch-up is on by default");
  assert.equal(created.json.retries, 2, "failed runs retry twice by default");

  const list = await app.call("GET", "/api/jobs");
  assert.equal(list.json.length, 1);

  const updated = await app.call("PUT", `/api/jobs/${created.json.id}`, {
    ...created.json,
    agent: "codex",
    enabled: false,
    catchUp: false,
    retries: 0,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.effectiveAgent, "codex");
  assert.equal(updated.json.catchUp, false);
  assert.equal(updated.json.retries, 0);
  const { catchUp: _catchUp, retries: _retries, ...older } = updated.json;
  const fromOlderClient = await app.call("PUT", `/api/jobs/${created.json.id}`, older);
  assert.equal(fromOlderClient.json.catchUp, false, "clients that don't send catch-up keep it");
  assert.equal(fromOlderClient.json.retries, 0);
  assert.equal(updated.json.nextRunAt, null, "paused jobs are unscheduled");
  assert.equal(updated.json.webhookToken, created.json.webhookToken, "the token survives edits");

  const deleted = await app.call("DELETE", `/api/jobs/${created.json.id}`, {});
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.equal((await app.call("GET", `/api/jobs/${created.json.id}`)).status, 404);
});

test("job validation reports each bad field", async (t) => {
  const app = await startApp(t);
  const res = await app.call("POST", "/api/jobs", {
    name: "",
    repoPath: "/definitely/not/here",
    prompt: "",
    agent: "gpt",
    schedule: "every tuesday",
    timeoutMinutes: 0,
    retries: 9,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.json.fields).sort(), [
    "agent",
    "name",
    "prompt",
    "repoPath",
    "retries",
    "schedule",
    "timeoutMinutes",
  ]);

  const badRef = await app.call("POST", "/api/jobs", { name: "x", repoPath: app.repo, baseRef: "nope", prompt: "y" });
  assert.deepEqual(Object.keys(badRef.json.fields), ["baseRef"]);
});

test("webhooks need the job's token and pass the payload to the run", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("noop");
  const job = (await app.call("POST", "/api/jobs", { name: "Bugs", repoPath: app.repo, prompt: "Fix: {{payload}}", webhookEnabled: true })).json;

  assert.equal((await app.call("POST", `/api/hooks/${job.id}`, "{}", { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await app.call("POST", `/api/hooks/${job.id}`, "{}", { authorization: "" })).status, 401);

  const finished = new Promise<Run>((resolve) => app.runner.once("finished", resolve));
  const res = await app.call("POST", `/api/hooks/${job.id}`, '{"title":"Crash on save"}', {
    authorization: `Bearer ${job.webhookToken}`,
    "content-type": "text/plain",
  });
  assert.equal(res.status, 202);
  assert.equal(res.json.trigger, "webhook");
  assert.match(res.json.payload, /"title": "Crash on save"/);
  assert.equal((await finished).status, "succeeded");

  const viaQuery = await app.call("POST", `/api/hooks/${job.id}?token=${job.webhookToken}`, "plain text bug", { authorization: "" });
  assert.equal(viaQuery.status, 202);
  await waitForFinish(app.runner, viaQuery.json.id);
});

test("ids are never reused and deleting a job removes its run logs", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("noop");
  const create = async () => (await app.call("POST", "/api/jobs", { name: "Temp", repoPath: app.repo, prompt: "x" })).json;
  const job = await create();
  const run = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  await waitForFinish(app.runner, run.id);
  assert.ok(existsSync(app.runner.logPath(run.id)));
  assert.equal((await app.call("DELETE", `/api/jobs/${job.id}`, {})).status, 200);
  assert.equal(existsSync(app.runner.logPath(run.id)), false);

  const next = await create();
  assert.ok(next.id > job.id);
  const nextRun = (await app.call("POST", `/api/jobs/${next.id}/run`, {})).json;
  assert.ok(nextRun.id > run.id);
  await waitForFinish(app.runner, nextRun.id);
});

test("manual runs, run listing, logs and cancel", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("sleep");
  const job = (await app.call("POST", "/api/jobs", { name: "Slow", repoPath: app.repo, prompt: "wait" })).json;
  const run = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  assert.equal(run.status, "running");
  assert.equal((await app.call("GET", `/api/runs?jobId=${job.id}`)).json.length, 1);

  const finished = waitForFinish(app.runner, run.id);
  assert.equal((await app.call("POST", `/api/runs/${run.id}/cancel`, {})).status, 200);
  await finished;
  const log = (await app.call("GET", `/api/runs/${run.id}/log?offset=0`)).json;
  assert.match(log.text, /Finished: canceled/);
  assert.equal(log.done, true);
  const tail = (await app.call("GET", `/api/runs/${run.id}/log?offset=${log.offset}`)).json;
  assert.equal(tail.text, "");
});

test("settings validate commands and report availability", async (t) => {
  const app = await startApp(t);
  const settings = (await app.call("GET", "/api/settings")).json;
  assert.equal(settings.defaultAgent, "pi");
  assert.equal(settings.agentInfo.length, 3);

  const bad = await app.call("PUT", "/api/settings", { ...settings, agents: { ...settings.agents, pi: { command: "" } }, maxConcurrent: 0 });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.json.fields).sort(), ["agents.pi", "maxConcurrent"]);

  const good = await app.call("PUT", "/api/settings", { ...settings, defaultAgent: "claude", agents: { ...settings.agents, codex: { command: "/bin/echo {prompt}" } } });
  assert.equal(good.status, 200);
  assert.equal(good.json.defaultAgent, "claude");
  assert.equal(good.json.agentInfo.find((a: { id: string }) => a.id === "codex").executable, "/bin/echo");
});

test("requests from other hosts, cross-origin writes and form posts are rejected", async (t) => {
  const app = await startApp(t);
  assert.equal((await app.call("GET", "/api/jobs", undefined, { host: "evil.example" })).status, 403);
  assert.equal((await app.call("POST", "/api/jobs", {}, { origin: "http://evil.example" })).status, 403);
  assert.equal((await app.call("POST", "/api/jobs", "name=x", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await app.call("GET", "/")).status, 503, "UI missing is reported, not crashed");
  assert.equal((await app.call("POST", "/api/jobs", {}, { origin: "null" })).status, 403);
  assert.equal((await app.call("GET", "/%E0%A4%A")).status, 400);
  assert.equal((await app.call("GET", "/api/runs?limit=abc")).status, 400);
  assert.equal((await app.call("GET", "/api/runs?jobId=1.5")).status, 400);
});

test("index.html gets a <base href> from a valid proxy prefix; health answers any host", async (t) => {
  const app = await startApp(t);
  const uiDir = path.join(app.root, "no-ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(path.join(uiDir, "index.html"), '<head><base href="/" /></head>');
  const page = async (headers: Record<string, string>) => (await app.call("GET", "/jobs/3", undefined, headers)).json;
  assert.match(await page({}), /<base href="\/" \/>/);
  assert.match(await page({ "x-forwarded-prefix": "/pi-jobs" }), /<base href="\/pi-jobs\/" \/>/);
  assert.match(await page({ "x-forwarded-prefix": '/x"><script>' }), /<base href="\/" \/>/);
  assert.equal((await app.call("GET", "/api/health", undefined, { host: "192.168.1.8" })).status, 200);
  assert.equal((await app.call("GET", "/api/jobs", undefined, { host: "192.168.1.8" })).status, 403);
});

test("schedule preview", async (t) => {
  const app = await startApp(t);
  const ok = (await app.call("GET", `/api/schedule-preview?expression=${encodeURIComponent("0 9 * * 1-5")}`)).json;
  assert.equal(ok.valid, true);
  assert.equal(ok.next.length, 3);
  const bad = (await app.call("GET", "/api/schedule-preview?expression=nope")).json;
  assert.equal(bad.valid, false);
});

test("the API requires a token; health and the UI shell do not", async (t) => {
  const app = await startApp(t);
  assert.equal((await app.call("GET", "/api/jobs", undefined, { authorization: "" })).status, 401);
  assert.equal((await app.call("GET", "/api/jobs", undefined, { authorization: "Bearer pjt_wrong" })).status, 401);
  const health = await app.call("GET", "/api/health", undefined, { authorization: "" });
  assert.equal(health.status, 200);
  assert.equal(health.json.apiVersion, 1);
  assert.match(health.json.version, /^\d+\.\d+\.\d+$/);
  assert.equal((await app.call("GET", "/jobs/1", undefined, { authorization: "" })).status, 503, "static shell, no auth");
  assert.equal((await app.call("GET", "/api/session")).json.token.name, "test");
});

test("tokens can be created, listed and revoked", async (t) => {
  const app = await startApp(t);
  const created = await app.call("POST", "/api/tokens", { name: "laptop" });
  assert.equal(created.status, 201);
  assert.match(created.json.secret, /^pjt_[\w-]{43}$/);
  assert.equal((await app.call("POST", "/api/tokens", { name: "laptop" })).status, 409);
  assert.equal((await app.call("POST", "/api/tokens", { name: "" })).status, 400);

  const chosen = `pjt_${"chosen-by-owner_".repeat(2)}`;
  const own = await app.call("POST", "/api/tokens", { name: "admin", token: chosen });
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal(own.json.secret, chosen);
  assert.equal((await app.call("GET", "/api/jobs", undefined, { authorization: `Bearer ${chosen}` })).status, 200);
  const reused = await app.call("POST", "/api/tokens", { name: "other", token: chosen });
  assert.equal(reused.status, 409);
  assert.deepEqual(Object.keys(reused.json.fields), ["token"]);
  for (const bad of ["short", "pjt_short", `pjt_${"x".repeat(20)} with spaces`, "x".repeat(30)]) {
    const res = await app.call("POST", "/api/tokens", { name: "bad", token: bad });
    assert.equal(res.status, 400, bad);
    assert.deepEqual(Object.keys(res.json.fields), ["token"]);
  }
  const list = (await app.call("GET", "/api/tokens")).json;
  assert.deepEqual(list.map((x: { name: string }) => x.name), ["test", "laptop", "admin"]);
  assert.ok(!JSON.stringify(list).includes(created.json.secret), "secrets are never listed");
  assert.ok(!JSON.stringify(list).includes(chosen), "chosen secrets are never listed");
  const auth = { authorization: `Bearer ${created.json.secret}` };
  assert.equal((await app.call("GET", "/api/jobs", undefined, auth)).status, 200);
  assert.equal((await app.call("DELETE", `/api/tokens/${created.json.token.id}`, {})).status, 200);
  assert.equal((await app.call("GET", "/api/jobs", undefined, auth)).status, 401);
});

test("log tail returns the end of the log", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("noop");
  const job = (await app.call("POST", "/api/jobs", { name: "Tail", repoPath: app.repo, prompt: "x" })).json;
  const run = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  await waitForFinish(app.runner, run.id);
  const full = (await app.call("GET", `/api/runs/${run.id}/log?offset=0`)).json;
  const tail = (await app.call("GET", `/api/runs/${run.id}/log?tail=40`)).json;
  assert.ok(full.text.endsWith(tail.text));
  assert.ok(tail.text.length <= 40 && tail.text.includes("Finished: succeeded"));
});

test("repos resolve by remote URL", async (t) => {
  const app = await startApp(t);
  git(app.repo, "remote", "add", "origin", "/srv/repos/demo.git");
  const resolve = (body: unknown) => app.call("POST", "/api/repos/resolve", body);
  const found = await resolve({ remotes: ["me@server:/srv/repos/demo.git"] });
  assert.equal(found.status, 200, JSON.stringify(found.json));
  assert.equal(found.json.path, app.repo);
  assert.equal((await resolve({ remotes: ["https://github.com/someone/else.git"] })).status, 404);
  assert.equal((await resolve({ remotes: [] })).status, 400);
});
