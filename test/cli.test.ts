import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function sandbox(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, "state");
  const clientFile = path.join(home, ".config", "pi-jobs", "client.json");
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, PI_JOBS_STATE_DIR: state, PI_JOBS_PORT: "8799" },
      input,
      encoding: "utf8",
    });
  const client = () => JSON.parse(readFileSync(clientFile, "utf8")) as { url: string; token: string };
  const tokenNames = () => {
    const store = new Store(path.join(state, "pi-jobs.db"));
    try {
      return store.listTokens().map((t) => t.name);
    } finally {
      store.close();
    }
  };
  return { home, run, client, clientFile, tokenNames };
}

test("token create prints a token once; list and revoke manage it", (t) => {
  const box = sandbox(t);
  const created = box.run(["token", "create", "admin"]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout.trim(), /^pjt_[\w-]{43}$/);
  assert.equal(box.run(["token", "create", "admin"]).status, 1, "names are unique");
  assert.match(box.run(["token", "list"]).stdout, /^admin\tcreated /);
  assert.ok(!box.run(["token", "list"]).stdout.includes(created.stdout.trim()));
  assert.equal(box.run(["token", "revoke", "admin"]).status, 0);
  assert.deepEqual(box.tokenNames(), []);
});

test("connect-local mints one token and is idempotent", (t) => {
  const box = sandbox(t);
  assert.equal(box.run(["connect-local"]).status, 0);
  const first = box.client();
  assert.equal(first.url, "http://127.0.0.1:8799");
  assert.equal(statSync(box.clientFile).mode & 0o777, 0o600);
  assert.match(box.run(["connect-local"]).stdout, /already use this server/);
  assert.deepEqual(box.client(), first);
  assert.equal(box.tokenNames().length, 1);

  // A revoked token is replaced.
  box.run(["token", "revoke", box.tokenNames()[0]!]);
  box.run(["connect-local"]);
  assert.notEqual(box.client().token, first.token);
  assert.equal(box.tokenNames().length, 1);
});

test("connect-local leaves a remote server's client config alone", (t) => {
  const box = sandbox(t);
  mkdirSync(path.dirname(box.clientFile), { recursive: true });
  writeFileSync(box.clientFile, JSON.stringify({ url: "https://studio.example.ts.net/pi-jobs", token: "pjt_remote" }));
  assert.match(box.run(["connect-local"]).stdout, /already use https:\/\/studio\.example\.ts\.net\/pi-jobs/);
  assert.equal(box.client().token, "pjt_remote");
  assert.deepEqual(box.tokenNames(), []);
});

test("client-config reads the token from stdin and refuses unsafe URLs", (t) => {
  const box = sandbox(t);
  const token = "pjt_abcdefghijklmnopqrstuvwxyz0123";
  assert.equal(box.run(["client-config", "http://studio.example"], token).status, 2);
  assert.equal(box.run(["client-config", "https://studio.example/pi-jobs/"], "not-a-token").status, 1);
  const saved = box.run(["client-config", "https://studio.example/pi-jobs/"], `${token}\n`);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(box.client(), { url: "https://studio.example/pi-jobs", token });
  assert.equal(box.run(["client-config", "http://100.64.0.1/pi-jobs"], token).status, 0, "tailnet HTTP is fine");
  assert.equal(box.run(["bogus"]).status, 2);
});
