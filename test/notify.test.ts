import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { Notifier, finishedNotification } from "../src/notify.ts";
import { Store, type Job, type Run } from "../src/store.ts";

const run = (overrides: Partial<Run>): Run =>
  ({ id: 3, jobId: 1, mode: "change", status: "succeeded", commits: 0, checkStatus: null, summary: null, error: null, ...overrides }) as Run;
const job = { id: 1, name: "Triage", autoRelease: false } as Job;

test("finished runs notify only when they need the owner", () => {
  assert.equal(finishedNotification(run({ summary: "Implemented it", commits: 1 }), job, false)?.event, "review");
  assert.equal(finishedNotification(run({ summary: "Verdict: needs the owner's decision" }), job, false)?.event, "decision");
  assert.equal(finishedNotification(run({ status: "failed", error: "boom" }), job, false)?.event, "failed");
  assert.equal(finishedNotification(run({ status: "failed" }), job, true), null, "a retry is coming");
  assert.equal(finishedNotification(run({ mode: "ask", summary: "Answer" }), job, false), null);
  assert.equal(finishedNotification(run({ summary: "Nothing to do" }), job, false), null);
  assert.equal(finishedNotification(run({ mode: "release" }), job, false)?.event, "released");
  assert.equal(finishedNotification(run({ mode: "ship", status: "failed", error: "exit 1" }), job, false)?.event, "release_failed");
  const auto = { ...job, autoRelease: true, enabled: true, checkCommand: "npm test", releaseInstructions: "Release it" } as Job;
  assert.equal(finishedNotification(run({ summary: "Implemented it\nVerdict: implemented", commits: 1, checkStatus: "passed" }), auto, false), null, "its release says it");
  assert.equal(finishedNotification(run({ summary: "Implemented it\nVerdict: implemented", commits: 1, checkStatus: "failed" }), auto, false)?.event, "review");
  assert.equal(finishedNotification(run({ summary: "Implemented it", commits: 1, checkStatus: "passed" }), auto, false)?.event, "review", "no Verdict: line, no automatic release");
});

test("the notify command gets the event in its environment; failures are reported, not thrown", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-notify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "db"));
  t.after(() => store.close());
  const out = path.join(dir, "out.txt");
  const notifier = new Notifier(store, { ...loadConfig({}), port: 8790, host: "127.0.0.1" });
  assert.equal(await notifier.send({ event: "test", title: "T", message: "M", path: "/" }), null, "no command, nothing to do");
  store.saveSettings({ ...store.getSettings(), notifyCommand: `printf '%s|%s|%s|%s' "$PI_JOBS_EVENT" "$PI_JOBS_TITLE" "$PI_JOBS_URL" "$PI_JOBS_RUN_ID" > ${out}`, publicUrl: "https://host.example/pi-jobs" });
  assert.equal(await notifier.send({ event: "review", title: "Ready", message: "M", path: "/runs/4", runId: 4 }), null);
  assert.equal(readFileSync(out, "utf8"), "review|Ready|https://host.example/pi-jobs/runs/4|4");
  store.saveSettings({ ...store.getSettings(), notifyCommand: "echo nope >&2; exit 2" });
  assert.equal(await notifier.send({ event: "test", title: "T", message: "M", path: "/" }), "The notify command exited with code 2: nope");
});
