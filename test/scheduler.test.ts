import assert from "node:assert/strict";
import { test } from "node:test";
import { Scheduler } from "../src/scheduler.ts";
import type { Job } from "../src/store.ts";

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 1,
  name: "Daily",
  repoPath: "/r",
  baseRef: "main",
  prompt: "p",
  agent: null,
  schedule: "0 6 * * *",
  timeoutMinutes: 30,
  checkCommand: null,
  pushBranch: false,
  catchUp: true,
  retries: 2,
  enabled: true,
  webhookToken: null,
  lastFiredAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const local = (time: string) => new Date(time).toISOString();

test("missed() finds a fire that came due since the job last fired or was saved", () => {
  const scheduler = new Scheduler(() => {});
  const now = new Date("2026-03-02T07:00:00");
  const firedToday = local("2026-03-02T06:00:01");
  const firedYesterday = local("2026-03-01T06:00:01");
  assert.equal(scheduler.missed(job({ lastFiredAt: firedToday }), now), false);
  assert.equal(scheduler.missed(job({ lastFiredAt: firedYesterday }), now), true);
  assert.equal(scheduler.missed(job({ updatedAt: local("2026-03-02T06:30:00") }), now), false, "saved after today's fire");
  assert.equal(scheduler.missed(job({ lastFiredAt: firedYesterday, enabled: false }), now), false);
  assert.equal(scheduler.missed(job({ lastFiredAt: firedYesterday, schedule: null }), now), false);
});

test("an on-time fire is not reported as missed", async (t) => {
  const fires: boolean[] = [];
  const scheduler = new Scheduler((_id, missed) => fires.push(missed));
  t.after(() => scheduler.stop());
  scheduler.sync(job({ schedule: "* * * * * *" }));
  while (fires.length === 0) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fires, [false]);
});
