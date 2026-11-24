import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";
import { ChatRunner } from "../src/chat.ts";
import { loadConfig } from "../src/config.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Run } from "../src/store.ts";
import { git, setup, waitForFinish } from "./helpers.ts";

async function startApp(t: TestContext) {
  const ctx = setup();
  const config = { ...loadConfig({}), stateDir: path.join(ctx.root, "state"), uiDir: path.join(ctx.root, "no-ui"), repoRoots: [ctx.root] };
  const scheduler = new Scheduler(() => {});
  const chats = new ChatRunner({ store: ctx.store, stateDir: config.stateDir, killGraceMs: 500 });
  const server = createServer(createApp({ config, store: ctx.store, runner: ctx.runner, scheduler, chats }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const { secret } = ctx.store.createToken("test");
  t.after(async () => {
    scheduler.stop();
    server.close();
    await chats.shutdown();
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
  return { ...ctx, call, scheduler, secret, chats };
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

  // Another Pi launcher, added by name, can be the default and a job's agent; it can't be removed while a job uses it.
  const added = await app.call("PUT", "/api/settings", {
    ...good.json,
    defaultAgent: "pi-claude",
    agents: { ...good.json.agents, "pi-claude": { command: "/bin/echo --model x {prompt}" } },
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual(Object.keys(added.json.agents), ["pi", "claude", "codex", "pi-claude"]);
  const info = added.json.agentInfo.find((a: { id: string }) => a.id === "pi-claude");
  assert.deepEqual([info.label, info.builtin, info.preset], ["pi-claude", false, null]);
  const badName = await app.call("PUT", "/api/settings", { ...added.json, agents: { ...added.json.agents, "Bad Name": { command: "pi" } } });
  assert.deepEqual(Object.keys(badName.json.fields), ["agents.Bad Name"]);
  const job = await app.call("POST", "/api/jobs", { name: "j", repoPath: app.repo, baseRef: "main", prompt: "p", agent: "pi-claude" });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  assert.equal(job.json.agent, "pi-claude");
  const unknown = await app.call("POST", "/api/jobs", { name: "j", repoPath: app.repo, baseRef: "main", prompt: "p", agent: "nope" });
  assert.equal(unknown.json.fields.agent, "Choose one of pi, claude, codex, pi-claude, or the default");
  const { "pi-claude": _removed, ...builtins } = added.json.agents;
  const inUse = await app.call("PUT", "/api/settings", { ...added.json, defaultAgent: "pi", agents: builtins });
  assert.equal(inUse.status, 400);
  assert.match(inUse.json.fields["agents.pi-claude"], /Job #\d+ "j" uses this agent/);
  await app.call("PUT", `/api/jobs/${job.json.id}`, { ...job.json, agent: null });
  const removed = await app.call("PUT", "/api/settings", { ...added.json, defaultAgent: "pi", agents: builtins });
  assert.equal(removed.status, 200);
  assert.deepEqual(Object.keys(removed.json.agents), ["pi", "claude", "codex"]);
});

test("release instructions and release scripts exclude each other; autoRelease needs one and a check; updates change only what they send", async (t) => {
  const app = await startApp(t);
  const base = { name: "j", repoPath: app.repo, baseRef: "main", prompt: "p" };
  const both = await app.call("POST", "/api/jobs", { ...base, shipCommand: "true", releaseInstructions: "Release it" });
  assert.equal(both.status, 400);
  assert.match(both.json.fields.releaseInstructions, /not both/);
  const lonely = await app.call("POST", "/api/jobs", { ...base, autoRelease: true });
  assert.match(lonely.json.fields.autoRelease, /release instructions or a release script first/);
  const unchecked = await app.call("POST", "/api/jobs", { ...base, releaseInstructions: "Release it", autoRelease: true });
  assert.match(unchecked.json.fields.autoRelease, /Add a check command first/);
  const verifyAlone = await app.call("POST", "/api/jobs", { ...base, verifyCommand: "true" });
  assert.match(verifyAlone.json.fields.verifyCommand, /release instructions or a release script first/);
  const job = await app.call("POST", "/api/jobs", { ...base, releaseInstructions: "Release it", autoRelease: true, checkCommand: "true", verifyCommand: "curl -f localhost" });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  assert.deepEqual([job.json.releaseInstructions, job.json.autoRelease, job.json.verifyCommand], ["Release it", true, "curl -f localhost"]);
  // Older clients leave new fields out, and their updates keep them.
  const { releaseInstructions: _r, autoRelease: _a, verifyCommand: _v, ...older } = job.json;
  const kept = await app.call("PUT", `/api/jobs/${job.json.id}`, older);
  assert.deepEqual([kept.json.releaseInstructions, kept.json.autoRelease, kept.json.verifyCommand], ["Release it", true, "curl -f localhost"]);
  // PATCH (and PUT) change only the fields sent: the check command survives a rename.
  const renamed = await app.call("PATCH", `/api/jobs/${job.json.id}`, { name: "renamed" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.deepEqual([renamed.json.name, renamed.json.checkCommand, renamed.json.enabled, renamed.json.timeoutMinutes], ["renamed", "true", true, 30]);
  const paused = await app.call("PATCH", `/api/jobs/${job.json.id}`, { enabled: false });
  assert.deepEqual([paused.json.enabled, paused.json.name], [false, "renamed"]);
  // A job saved before automatic releases needed a check can still be paused; turning it on again asks for one.
  app.store.updateJob(job.json.id, { ...app.store.getJob(job.json.id)!, checkCommand: null }, null);
  assert.equal((await app.call("PATCH", `/api/jobs/${job.json.id}`, { enabled: true })).status, 200);
  assert.equal((await app.call("PATCH", `/api/jobs/${job.json.id}`, { autoRelease: true })).status, 400);
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
  const password = await app.call("POST", "/api/tokens", { name: "me", token: "password" });
  assert.equal(password.status, 201, "any password works, however weak");
  assert.equal((await app.call("GET", "/api/jobs", undefined, { authorization: "Bearer password" })).status, 200);
  const spaced = "correct horse ~!@#$%^&*()";
  assert.equal((await app.call("POST", "/api/tokens", { name: "phrase", token: spaced })).status, 201);
  assert.equal((await app.call("GET", "/api/jobs", undefined, { authorization: `Bearer ${spaced}` })).status, 200);
  for (const bad of [" password", "password ", "pass\nword", "pässword", "x".repeat(201)]) {
    const res = await app.call("POST", "/api/tokens", { name: "bad", token: bad });
    assert.equal(res.status, 400, bad);
    assert.deepEqual(Object.keys(res.json.fields), ["token"]);
  }
  const list = (await app.call("GET", "/api/tokens")).json;
  assert.deepEqual(list.map((x: { name: string }) => x.name), ["test", "laptop", "admin", "me", "phrase"]);
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

test("watch jobs: check now, approval, and updates from older clients keep the watch", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("noop");
  const plain = (await app.call("POST", "/api/jobs", { name: "Plain", repoPath: app.repo, prompt: "x" })).json;
  assert.equal(plain.watchCommand, null);
  assert.equal(plain.approveRuns, false);
  assert.equal((await app.call("POST", `/api/jobs/${plain.id}/watch`, {})).status, 409);

  const job = (await app.call("POST", "/api/jobs", {
    name: "Triage", repoPath: app.repo, prompt: "Triage {{payload}}", watchCommand: `echo '{"id":"r1"}'`, approveRuns: true,
  })).json;
  assert.deepEqual([job.watchCommand, job.approveRuns, job.watchCheckedAt], [`echo '{"id":"r1"}'`, true, null]);

  const checked = await app.call("POST", `/api/jobs/${job.id}/watch`, {});
  assert.equal(checked.status, 200);
  assert.equal(checked.json.runs.length, 1);
  const waiting = checked.json.runs[0];
  assert.deepEqual([waiting.status, waiting.trigger], ["awaiting_approval", "watch"]);
  assert.equal((await app.call("POST", `/api/jobs/${job.id}/watch`, {})).json.seen, 1);
  assert.equal((await app.call("DELETE", `/api/jobs/${job.id}`, {})).status, 409, "a waiting run blocks deletion");

  assert.equal((await app.call("POST", "/api/runs/99999/approve", {})).status, 404);
  const paused = (await app.call("PUT", `/api/jobs/${job.id}`, { ...job, enabled: false })).json;
  assert.equal(paused.enabled, false);
  const refused = await app.call("POST", `/api/runs/${waiting.id}/approve`, {});
  assert.deepEqual([refused.status, refused.json.error], [409, "Job is paused; resume it to approve its runs"]);
  await app.call("PUT", `/api/jobs/${job.id}`, { ...job, enabled: true });
  const approved = await app.call("POST", `/api/runs/${waiting.id}/approve`, {});
  assert.equal(approved.status, 200);
  assert.notEqual(approved.json.status, "awaiting_approval");
  await waitForFinish(app.runner, waiting.id);
  assert.equal((await app.call("POST", `/api/runs/${waiting.id}/approve`, {})).status, 409);

  // pi-shared's jobs tools from before watch commands send neither field.
  const { watchCommand: _watch, approveRuns: _approve, ...older } = job;
  const updated = (await app.call("PUT", `/api/jobs/${job.id}`, { ...older, name: "Triage 2" })).json;
  assert.deepEqual([updated.name, updated.watchCommand, updated.approveRuns], ["Triage 2", `echo '{"id":"r1"}'`, true]);
  const cleared = (await app.call("PUT", `/api/jobs/${job.id}`, { ...older, watchCommand: "", approveRuns: false })).json;
  assert.deepEqual([cleared.watchCommand, cleared.approveRuns], [null, false]);

  const tooLong = await app.call("POST", "/api/jobs", { name: "Long", repoPath: app.repo, prompt: "x", watchCommand: "x".repeat(4001) });
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.json.fields.watchCommand);
});

test("follow-ups need a finished run and instructions", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("sleep");
  const job = (await app.call("POST", "/api/jobs", { name: "Slow", repoPath: app.repo, prompt: "wait" })).json;
  const run = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  assert.equal((await app.call("POST", `/api/runs/${run.id}/follow-up`, { instructions: "More" })).status, 409);
  const finished = waitForFinish(app.runner, run.id);
  await app.call("POST", `/api/runs/${run.id}/cancel`, {});
  await finished;

  const empty = await app.call("POST", `/api/runs/${run.id}/follow-up`, { instructions: "  " });
  assert.equal(empty.status, 400);
  assert.ok(empty.json.fields.instructions);
  assert.equal((await app.call("POST", "/api/runs/999/follow-up", { instructions: "More" })).status, 404);

  app.useFakeAgent("noop");
  const followUp = await app.call("POST", `/api/runs/${run.id}/follow-up`, { instructions: " Finish it " });
  assert.equal(followUp.status, 200);
  assert.equal(followUp.json.followUpOf, run.id);
  assert.equal(followUp.json.instructions, "Finish it");
  await waitForFinish(app.runner, followUp.json.id);
});

test("run views carry a summary headline and merge state; changes are served per run", async (t) => {
  const { summaryHeadline } = await import("../src/report.ts");
  assert.equal(summaryHeadline("\n**HS-1: feature idea, needs the owner's decision.**\n- more"), "HS-1: feature idea, needs the owner's decision.");
  assert.equal(summaryHeadline("## Done\nx"), "Done");
  assert.equal(summaryHeadline(""), null);
  const { summaryVerdict } = await import("../src/report.ts");
  assert.equal(summaryVerdict("**HS-1**\n- **Verdict:** can't reproduce\n- x"), "- **Verdict:** can't reproduce");
  assert.equal(summaryVerdict("no verdict here"), null);

  const app = await startApp(t);
  app.useFakeAgent("commit");
  const job = (await app.call("POST", "/api/jobs", { name: "Edit", repoPath: app.repo, prompt: "go" })).json;
  const started = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  await waitForFinish(app.runner, started.id);
  const run = (await app.call("GET", `/api/runs/${started.id}`)).json;
  assert.match(run.summaryHeadline, /^fake agent \(commit\)/);
  assert.equal(run.merged, false);
  const [listed] = (await app.call("GET", "/api/runs")).json;
  assert.equal(listed.summary, undefined, "lists leave out the full report");
  assert.equal(listed.summaryHeadline, run.summaryHeadline);
  const changes = (await app.call("GET", `/api/runs/${started.id}/changes`)).json;
  assert.deepEqual(changes.files.map((f: { path: string }) => f.path), ["committed.txt"]);

  app.useFakeAgent("noop");
  const empty = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  await waitForFinish(app.runner, empty.id);
  assert.equal((await app.call("GET", `/api/runs/${empty.id}/changes`)).status, 404);
});

test("runs can be marked replied and closed once finished; all watches can be checked at once", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("sleep");
  const job = (await app.call("POST", "/api/jobs", { name: "Slow", repoPath: app.repo, prompt: "wait" })).json;
  const run = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  assert.equal((await app.call("POST", `/api/runs/${run.id}/closed`, { value: true })).status, 409);
  const finished = waitForFinish(app.runner, run.id);
  await app.call("POST", `/api/runs/${run.id}/cancel`, {});
  await finished;

  assert.equal((await app.call("POST", `/api/runs/${run.id}/replied`, {})).status, 400);
  const replied = (await app.call("POST", `/api/runs/${run.id}/replied`, { value: true })).json;
  assert.ok(replied.repliedAt);
  const closed = (await app.call("POST", `/api/runs/${run.id}/closed`, { value: true })).json;
  assert.ok(closed.closedAt);
  assert.equal((await app.call("POST", `/api/runs/${run.id}/closed`, { value: false })).json.closedAt, null);

  await app.call("POST", "/api/jobs", {
    name: "Inbox",
    repoPath: app.repo,
    prompt: "triage",
    watchCommand: `echo '{"id": "a"}'`,
    approveRuns: true,
  });
  const checks = (await app.call("POST", "/api/watches/check", {})).json;
  assert.equal(checks.length, 1);
  assert.equal(checks[0].started, 1);
  assert.equal(checks[0].error, null);
});

test("follow-ups take a mode; a run's thread lists its item's runs with their reports", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("noop");
  const job = (await app.call("POST", "/api/jobs", { name: "Thread", repoPath: app.repo, prompt: "go" })).json;
  const root = (await app.call("POST", `/api/jobs/${job.id}/run`, {})).json;
  await waitForFinish(app.runner, root.id);
  const bad = await app.call("POST", `/api/runs/${root.id}/follow-up`, { instructions: "Why?", mode: "chat" });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.mode);
  const ask = (await app.call("POST", `/api/runs/${root.id}/follow-up`, { instructions: "Why?", mode: "ask" })).json;
  assert.equal(ask.mode, "ask");
  assert.equal(ask.itemId, root.id);
  await waitForFinish(app.runner, ask.id);
  const thread = (await app.call("GET", `/api/runs/${ask.id}/thread`)).json;
  assert.deepEqual(thread.map((r: Run) => r.id), [root.id, ask.id]);
  assert.match(thread[1].summary, /fake agent \(noop\)/);
  assert.equal(typeof thread[0].merged, "boolean");
  assert.equal((await app.call("GET", "/api/runs/999/thread")).status, 404);
});

test("ship: the job keeps its ship command across older clients' updates; POST /ship refuses what can't ship", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("commit");
  const created = await app.call("POST", "/api/jobs", { name: "Release", repoPath: app.repo, prompt: "go", shipCommand: "  echo shipping  " });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.shipCommand, "echo shipping");
  const kept = await app.call("PUT", `/api/jobs/${created.json.id}`, { name: "Release", repoPath: app.repo, prompt: "go again" });
  assert.equal(kept.json.shipCommand, "echo shipping", "an update without the field keeps it");
  const long = await app.call("PUT", `/api/jobs/${created.json.id}`, { name: "Release", repoPath: app.repo, prompt: "go", shipCommand: "x".repeat(4001) });
  assert.equal(long.status, 400);
  assert.ok(long.json.fields.shipCommand);

  const run = (await app.call("POST", `/api/jobs/${created.json.id}/run`, {})).json;
  assert.equal((await app.call("POST", `/api/runs/${run.id}/ship`, {})).status, 409, "not while the item is running");
  await waitForFinish(app.runner, run.id);
  assert.equal((await app.call("POST", "/api/runs/999/ship", {})).status, 404);
  const shipped = await app.call("POST", `/api/runs/${run.id}/ship`, {});
  assert.equal(shipped.status, 200, JSON.stringify(shipped.json));
  assert.equal(shipped.json.mode, "ship");
  assert.equal((await waitForFinish(app.runner, shipped.json.id)).status, "succeeded");

  const cleared = await app.call("PUT", `/api/jobs/${created.json.id}`, { name: "Release", repoPath: app.repo, prompt: "go", shipCommand: "" });
  assert.equal(cleared.json.shipCommand, null);
  const refused = await app.call("POST", `/api/runs/${run.id}/ship`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /no release instructions or ship command/);
});

test("items, release previews and pinned releases through the API; who started a run is recorded", async (t) => {
  const app = await startApp(t);
  app.useFakeAgent("commit");
  const job = (await app.call("POST", "/api/jobs", { name: "Fixes", repoPath: app.repo, prompt: "go", shipCommand: "true" })).json;
  const started = await app.call("POST", `/api/jobs/${job.id}/run`, {});
  assert.equal(started.json.requestedBy, "test", "Run now records the token");
  const run = await waitForFinish(app.runner, started.json.id);

  const items = (await app.call("GET", `/api/items?jobId=${job.id}`)).json;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].state, items[0].canRelease, items[0].withChangesId, items[0].runs[0].summary], ["review", true, run.id, undefined]);
  assert.equal((await app.call("GET", "/api/items?waiting=1")).json.length, 1, "work to review waits on the owner");
  const item = (await app.call("GET", `/api/runs/${run.id}/item`)).json;
  assert.equal(typeof item.runs[0].summary, "string", "an item's page gets the reports");

  const preview = (await app.call("GET", `/api/runs/${run.id}/release-preview`)).json;
  assert.deepEqual(
    [preview.head, preview.ahead, preview.behind, preview.conflicts, preview.files, preview.kind, preview.instructions],
    [run.headCommit, 1, 0, false, 1, "script", "true"],
  );
  const moved = await app.call("POST", `/api/runs/${run.id}/release`, { expectedHead: "0".repeat(40) });
  assert.equal(moved.status, 409);
  assert.match(moved.json.error, /changed since you reviewed it/);
  assert.equal((await app.call("POST", `/api/runs/${run.id}/release`, { expectedHead: "abc" })).status, 400);
  const release = await app.call("POST", `/api/runs/${run.id}/release`, { expectedHead: run.headCommit });
  assert.equal(release.status, 200, JSON.stringify(release.json));
  assert.deepEqual([release.json.mode, release.json.requestedBy], ["ship", "test"]);
  await waitForFinish(app.runner, release.json.id);
  const after = (await app.call("GET", `/api/runs/${run.id}/item`)).json;
  assert.equal(after.state, "released");
  assert.equal((await app.call("GET", "/api/items?waiting=1")).json.length, 0);
});

test("notification settings: older clients keep them; the test needs a saved command", async (t) => {
  const app = await startApp(t);
  assert.equal((await app.call("POST", "/api/settings/notify-test", {})).status, 409);
  const settings = (await app.call("GET", "/api/settings")).json;
  const saved = await app.call("PUT", "/api/settings", { ...settings, notifyCommand: " true ", publicUrl: "https://host.example/pi-jobs/" });
  assert.deepEqual([saved.json.notifyCommand, saved.json.publicUrl], ["true", "https://host.example/pi-jobs"]);
  const { notifyCommand: _n, publicUrl: _p, ...older } = saved.json;
  const kept = await app.call("PUT", "/api/settings", older);
  assert.deepEqual([kept.json.notifyCommand, kept.json.publicUrl], ["true", "https://host.example/pi-jobs"]);
  const bad = await app.call("PUT", "/api/settings", { ...older, publicUrl: "host.example" });
  assert.equal(bad.json.fields.publicUrl, "Use an http:// or https:// address");
});
