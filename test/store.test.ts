import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/store.ts";

test("opening a database from before push_branch/pushed_to and catch-up/retries adds the columns", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, repo_path TEXT NOT NULL,
      base_ref TEXT NOT NULL, prompt TEXT NOT NULL, agent TEXT, schedule TEXT, webhook_token TEXT,
      timeout_minutes INTEGER NOT NULL, check_command TEXT, enabled INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, trigger TEXT NOT NULL,
      status TEXT NOT NULL, agent TEXT NOT NULL, payload TEXT, branch TEXT, worktree TEXT, base_commit TEXT,
      head_commit TEXT, commits INTEGER, exit_code INTEGER, check_status TEXT, error TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT);
    INSERT INTO jobs VALUES (1, 'Old', '/r', 'main', 'p', NULL, NULL, NULL, 30, NULL, 1, 'x', 'x');`);
  old.close();
  const store = new Store(file);
  t.after(() => store.close());
  assert.equal(store.getJob(1)?.pushBranch, false);
  assert.equal(store.getJob(1)?.catchUp, true);
  assert.equal(store.getJob(1)?.retries, 2);
  assert.equal(store.getJob(1)?.lastFiredAt, null);
  const run = store.createRun(1, "manual", "pi", null);
  assert.equal(run.pushedTo, null);
  assert.equal(run.attempt, 1);
  assert.equal(run.retryOf, null);
});

test("tokens are stored hashed and authenticate by secret", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const { token, secret } = store.createToken("laptop");
  assert.equal(store.authenticate(secret)?.id, token.id);
  assert.equal(store.authenticate(`${secret}x`), null);
  const raw = JSON.stringify(store.db.prepare("SELECT * FROM api_tokens").all());
  assert.ok(!raw.includes(secret));
  assert.ok(store.deleteToken(token.id));
  assert.equal(store.authenticate(secret), null);
});
