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

test("runs from before items were stored get their item from the run they retry or follow up on", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "items.db");
  const first = new Store(file);
  const job = first.createJob(
    { name: "j", repoPath: dir, baseRef: "main", prompt: "p", agent: null, schedule: null, timeoutMinutes: 5, checkCommand: null,
      pushBranch: false, catchUp: true, retries: 0, watchCommand: null, approveRuns: false, enabled: true },
    null,
  );
  const root = first.createRun(job.id, "watch", "pi", null);
  const followUp = first.createFollowUp(root, "pi", "go");
  const retry = first.createRetry(followUp, new Date());
  const other = first.createRun(job.id, "manual", "pi", null);
  assert.deepEqual([root, followUp, retry, other].map((r) => r.itemId), [root.id, root.id, root.id, other.id]);
  first.db.exec("UPDATE runs SET item_id = NULL");
  first.close();

  const reopened = new Store(file);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.itemRuns(root.id).map((r) => r.id), [root.id, followUp.id, retry.id]);
  assert.deepEqual(reopened.itemRuns(other.id).map((r) => r.id), [other.id]);
  assert.equal(reopened.getRun(retry.id)!.mode, "change");
});
