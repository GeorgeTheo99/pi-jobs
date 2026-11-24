import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";
import { ChatRunner, parseReply } from "../src/chat.ts";
import { loadConfig } from "../src/config.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { ChatTurn } from "../src/store.ts";
import { setup } from "./helpers.ts";

const FAKE_CHAT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-chat-agent.mjs");

async function startApp(t: TestContext, mode = "reply") {
  const ctx = setup();
  const config = { ...loadConfig({}), stateDir: path.join(ctx.root, "state"), uiDir: path.join(ctx.root, "no-ui"), repoRoots: [ctx.root] };
  const scheduler = new Scheduler(() => {});
  const chats = new ChatRunner({ store: ctx.store, stateDir: config.stateDir, killGraceMs: 500 });
  const server = createServer(createApp({ config, store: ctx.store, runner: ctx.runner, scheduler, chats }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const { secret } = ctx.store.createToken("test");
  const settings = ctx.store.getSettings();
  settings.agents.pi.command = `${process.execPath} ${FAKE_CHAT} ${mode} {prompt}`;
  ctx.store.saveSettings(settings);
  t.after(async () => {
    scheduler.stop();
    server.close();
    await chats.shutdown();
    await ctx.cleanup();
  });
  const call = (method: string, pathname: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: pathname,
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  const replied = (turnId: number) =>
    new Promise<ChatTurn>((resolve) => {
      const done = ctx.store.getTurn(turnId);
      if (done && done.status !== "running") return resolve(done);
      const onFinished = (turn: ChatTurn) => {
        if (turn.id !== turnId) return;
        chats.off("finished", onFinished);
        resolve(turn);
      };
      chats.on("finished", onFinished);
    });
  return { ...ctx, call, chats, replied, config };
}

const actions = (list: unknown[]) => `ACTIONS: ${JSON.stringify(list)}`;

test("parseReply takes the last actions block out of the reply", () => {
  const output = [
    "Warning: No project session found with id 'x'; creating a new session with that id.",
    "Here is the plan.",
    "```pi-jobs-actions",
    '[{"type": "run_job", "jobId": 1}]',
    "```",
    "Actually:",
    "```pi-jobs-actions",
    '{"type": "run_job", "jobId": 2}',
    "```",
  ].join("\n");
  assert.deepEqual(parseReply(output), { reply: "Here is the plan.\n\nActually:", proposals: [{ type: "run_job", jobId: 2 }], error: null });
  assert.deepEqual(parseReply("Just an answer."), { reply: "Just an answer.", proposals: null, error: null });
  const broken = parseReply("Try this\n```pi-jobs-actions\n[{oops}]\n```");
  assert.equal(broken.proposals, null);
  assert.match(broken.error ?? "", /weren't valid JSON/);
});

test("a chat replies with action cards; applying one goes through the API and refuses stale or decided ones", async (t) => {
  const app = await startApp(t);
  const job = (await app.call("POST", "/api/jobs", { name: "Nightly", repoPath: app.repo, prompt: "Check things", webhookEnabled: true })).json;
  const created = await app.call("POST", "/api/chats", {
    jobId: job.id,
    message: actions([
      { type: "update_job", jobId: job.id, changes: { schedule: "0 7 * * *" } },
      { type: "update_job", jobId: job.id, changes: { checkCommand: "npm test" } },
      { type: "launch_rockets" },
      { type: "run_job", jobId: 99 },
      { type: "update_job", jobId: job.id, changes: { colour: "red" } },
    ]),
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.busy, true);
  assert.equal(created.json.jobId, job.id);
  const turn = await app.replied(created.json.turns[0].id);
  assert.equal(turn.status, "succeeded", turn.error ?? "");
  assert.match(turn.reply ?? "", /^Reply 1 to: ACTIONS:/);
  assert.doesNotMatch(turn.reply ?? "", /stderr noise|pi-jobs-actions/);
  assert.deepEqual(
    turn.actions.map((a) => [a.status, a.risky, a.error]),
    [
      ["proposed", false, null],
      ["proposed", true, null],
      ["invalid", false, 'Unknown action type "launch_rockets"'],
      ["invalid", false, "Job #99 doesn't exist"],
      ["invalid", false, "Unknown job field: colour"],
    ],
  );
  assert.deepEqual(turn.actions[0]!.changes, [{ field: "schedule", before: "", after: "0 7 * * *" }]);
  assert.equal(turn.actions[0]!.title, `Change job #${job.id} "Nightly": schedule`);

  const prompt = readFileSync(path.join(app.chats.chatDir(created.json.id), "prompt-1.txt"), "utf8");
  assert.match(prompt, /^ACTIONS:/);
  assert.match(prompt, /You are the assistant in pi-jobs' chat #\d+.* It is about job #\d+\./);
  assert.match(prompt, /- update_settings \{"changes"/);
  assert.match(prompt, /"name": "Nightly"/);
  assert.match(prompt, /"webhook": true/);
  assert.ok(!prompt.includes(app.store.getJob(job.id)!.webhookToken!), "the webhook token is never in a prompt");

  const url = (index: number) => `/api/chats/${created.json.id}/turns/${turn.id}/actions/${index}`;
  const applied = await app.call("POST", url(0), { decision: "apply" });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.equal(applied.json.action.status, "applied");
  assert.equal(applied.json.action.result, `Saved job #${job.id} "Nightly"`);
  assert.equal(app.store.getJob(job.id)!.schedule, "0 7 * * *");
  assert.notEqual(app.store.getJob(job.id)!.webhookToken, null, "the rest of the job is kept");

  const stale = await app.call("POST", url(1), { decision: "apply" });
  assert.equal(stale.json.action.status, "failed");
  assert.match(stale.json.action.error, /changed since this was proposed/);
  assert.equal(app.store.getJob(job.id)!.checkCommand, null);
  assert.equal((await app.call("POST", url(1), { decision: "dismiss" })).status, 409);
  assert.equal((await app.call("POST", url(2), { decision: "apply" })).status, 409, "invalid actions can't be applied");
  assert.equal((await app.call("POST", url(9), { decision: "apply" })).status, 404);
  assert.equal((await app.call("POST", url(0), { decision: "maybe" })).status, 400);

  // Without a session to continue, the next prompt replays the conversation and what became of its actions.
  const next = await app.call("POST", `/api/chats/${created.json.id}/messages`, { message: "What now?" });
  await app.replied(next.json.turns[1].id);
  const second = readFileSync(path.join(app.chats.chatDir(created.json.id), "prompt-2.txt"), "utf8");
  assert.match(second, /^What now\?/);
  assert.match(second, /The conversation so far/);
  assert.match(second, /applied: Saved job #\d+ "Nightly"/);
  assert.match(second, /failed: Its target changed since this was proposed/);
  assert.match(second, /"schedule": "0 7 \* \* \*"/, "the state is current");
});

test("secrets made by an action reach the owner's card only", async (t) => {
  const app = await startApp(t);
  const job = (await app.call("POST", "/api/jobs", { name: "Hooked", repoPath: app.repo, prompt: "P", webhookEnabled: true })).json;
  const before = app.store.getJob(job.id)!.webhookToken;
  const chat = (
    await app.call("POST", "/api/chats", {
      message: actions([
        { type: "create_token", name: "phone" },
        { type: "rotate_webhook_token", jobId: job.id },
        { type: "create_token", name: "mine", token: "hunter2-hunter2" },
        { type: "update_settings", changes: { agents: { claude: { command: "claude -p {prompt}" } }, maxConcurrent: 3 } },
      ]),
    })
  ).json;
  const turn = await app.replied(chat.turns[0].id);
  assert.deepEqual(turn.actions.map((a) => [a.status, a.risky]), [["proposed", true], ["proposed", true], ["invalid", false], ["proposed", true]]);
  assert.deepEqual(turn.actions[3]!.changes.map((c) => c.field), ["maxConcurrent", "agents.claude.command"]);

  const url = (index: number) => `/api/chats/${chat.id}/turns/${turn.id}/actions/${index}`;
  const token = await app.call("POST", url(0), { decision: "apply" });
  assert.ok(typeof token.json.secret === "string" && token.json.secret.length >= 20);
  assert.ok(app.store.authenticate(token.json.secret), "the new token works");
  const hook = await app.call("POST", url(1), { decision: "apply" });
  const rotated = app.store.getJob(job.id)!.webhookToken!;
  assert.notEqual(rotated, before);
  assert.equal(hook.json.secret, rotated);
  const settings = await app.call("POST", url(3), { decision: "apply" });
  assert.equal(settings.json.action.status, "applied", settings.json.action.error);
  assert.equal(app.store.getSettings().maxConcurrent, 3);

  const stored = JSON.stringify((await app.call("GET", `/api/chats/${chat.id}`)).json);
  assert.ok(!stored.includes(token.json.secret) && !stored.includes(rotated), "secrets are never stored with the chat");
  await app.replied((await app.call("POST", `/api/chats/${chat.id}/messages`, { message: "Thanks" })).json.turns[1].id);
  const prompt = readFileSync(path.join(app.chats.chatDir(chat.id), "prompt-2.txt"), "utf8");
  assert.ok(!prompt.includes(token.json.secret) && !prompt.includes(rotated), "or shown to the agent");
  assert.match(prompt, /Created API token "phone" \(shown once on this card\)/);
});

test("one reply at a time per chat; replies can be stopped; failures and deletion are handled", async (t) => {
  const app = await startApp(t, "sleep");
  const chat = (await app.call("POST", "/api/chats", { message: "Think hard" })).json;
  assert.equal((await app.call("POST", `/api/chats/${chat.id}/messages`, { message: "Another" })).status, 409);
  assert.equal((await app.call("DELETE", `/api/chats/${chat.id}`)).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await app.call("POST", `/api/chats/${chat.id}/cancel`, {})).status, 200);
  const stopped = await app.replied(chat.turns[0].id);
  assert.equal(stopped.status, "canceled");
  assert.equal((await app.call("POST", `/api/chats/${chat.id}/cancel`, {})).status, 409);

  const settings = app.store.getSettings();
  settings.agents.pi.command = `${process.execPath} ${FAKE_CHAT} fail {prompt}`;
  app.store.saveSettings(settings);
  const next = await app.call("POST", `/api/chats/${chat.id}/messages`, { message: actions([{ type: "run_job", jobId: 1 }]) });
  const failed = await app.replied(next.json.turns[1].id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "The agent exited with code 2");
  assert.deepEqual(failed.actions, [], "a failed reply proposes nothing");
  const log = await app.call("GET", `/api/chats/${chat.id}/turns/${failed.id}/log`);
  assert.match(log.json.text, /stderr noise/);
  assert.equal(log.json.done, true);

  assert.equal((await app.call("POST", "/api/chats", { message: " " })).status, 400);
  assert.equal((await app.call("POST", "/api/chats", { message: "Hi", jobId: 99 })).status, 404);
  const list = await app.call("GET", "/api/chats");
  assert.equal(list.json[0].id, chat.id);
  assert.equal(list.json[0].lastTurn.status, "failed");
  assert.equal((await app.call("DELETE", `/api/chats/${chat.id}`)).status, 200);
  assert.equal(existsSync(app.chats.chatDir(chat.id)), false);
  assert.equal((await app.call("GET", `/api/chats/${chat.id}`)).status, 404);
});

test("with Pi, a chat's turns continue one session and are told what became of the last actions", async (t) => {
  const app = await startApp(t);
  const bin = path.join(app.root, "bin");
  const sessions = path.join(app.root, "sessions.txt");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "pi"),
    `#!/bin/sh\nif [ "$1" = "--session-id" ]; then echo "$2 $(pwd) $PI_JOBS_RUN_ID" >> '${sessions}'; shift 2; fi\nexec '${process.execPath}' '${FAKE_CHAT}' "$@"\n`,
  );
  chmodSync(path.join(bin, "pi"), 0o755);
  const settings = app.store.getSettings();
  settings.agents.pi.command = `${path.join(bin, "pi")} reply {prompt}`;
  app.store.saveSettings(settings);

  const job = (await app.call("POST", "/api/jobs", { name: "Paused soon", repoPath: app.repo, prompt: "P" })).json;
  const chat = (await app.call("POST", "/api/chats", { message: actions([{ type: "update_job", jobId: job.id, changes: { enabled: false } }]) })).json;
  const first = await app.replied(chat.turns[0].id);
  assert.equal(first.actions[0]!.title, `Pause job #${job.id} "Paused soon"`);
  await app.call("POST", `/api/chats/${chat.id}/turns/${first.id}/actions/0`, { decision: "dismiss" });
  await app.replied((await app.call("POST", `/api/chats/${chat.id}/messages`, { message: "Never mind" })).json.turns[1].id);

  const calls = readFileSync(sessions, "utf8").trim().split("\n").map((line) => line.split(" "));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]![0], chat.sessionId);
  assert.equal(calls[1]![0], chat.sessionId, "the same session each turn");
  assert.equal(calls[0]![1], calls[1]![1], "in the chat's own directory");
  assert.match(calls[0]![2]!, /^chat-turn-\d+$/, "marked as inside pi-jobs, so Pi's jobs_* tools stay off");
  const second = readFileSync(path.join(app.chats.chatDir(chat.id), "prompt-2.txt"), "utf8");
  assert.match(second, /This continues your conversation/);
  assert.doesNotMatch(second, /The conversation so far/);
  assert.match(second, /What happened to the actions you proposed in your last reply:\n- Pause job #\d+ "Paused soon": dismissed by the owner/);
});
