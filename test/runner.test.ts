import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, setup, waitForFinish } from "./helpers.ts";

test("a successful run commits the agent's changes to a branch and removes the worktree", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("edit");
  const job = ctx.store.createJob(ctx.jobInput({ checkCommand: "test -f agent-output.txt" }), null);

  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);

  assert.equal(run.status, "succeeded", run.error ?? "");
  assert.equal(run.exitCode, 0);
  assert.equal(run.checkStatus, "passed");
  assert.equal(run.commits, 1);
  assert.equal(run.worktree, null);
  assert.equal(run.branch, `pi-jobs/nightly-check/run-${run.id}`);
  const committed = git(ctx.repo, "show", `${run.branch}:agent-output.txt`);
  assert.match(committed, /^Do the thing/);
  assert.match(committed, /fresh git worktree/);
  assert.equal(git(ctx.repo, "log", "-1", "--format=%an", run.branch!), "pi-jobs");
  assert.equal(git(ctx.repo, "status", "--porcelain"), "", "the owner's checkout is untouched");
  assert.equal(existsSync(path.join(ctx.root, "state", "worktrees", `job-${job.id}`)), false, "no empty worktree directory is left");

  const log = readFileSync(ctx.runner.logPath(run.id), "utf8");
  assert.match(log, /fake agent \(edit\)/);
  assert.match(log, new RegExp(`run=${run.id}`));
});

test("a run with no changes leaves no branch behind", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("noop");
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded");
  assert.equal(run.commits, 0);
  assert.equal(run.branch, null);
  assert.equal(git(ctx.repo, "branch", "--list", "pi-jobs/*"), "");
});

test("commits made by the agent are kept", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("commit");
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded");
  assert.equal(run.commits, 1);
  assert.equal(git(ctx.repo, "log", "-1", "--format=%s", run.branch!), "agent commit");
});

test("a failing agent keeps its worktree and partial work", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("fail");
  const job = ctx.store.createJob(ctx.jobInput({ checkCommand: "echo should-not-run" }), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 3);
  assert.equal(run.checkStatus, null);
  assert.ok(run.worktree && existsSync(run.worktree));
  assert.equal(git(ctx.repo, "show", `${run.branch}:partial.txt`), "half done");
});

test("canceling a running job kills the agent", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("sleep");
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const finished = waitForFinish(ctx.runner, result.run.id);
  // Wait until the agent has started.
  while (!readFileSync(ctx.runner.logPath(result.run.id), "utf8").includes("fake agent")) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const started = Date.now();
  ctx.runner.cancel(result.run.id);
  const run = await finished;
  assert.equal(run.status, "canceled");
  assert.ok(Date.now() - started < 5_000);
});

test("shutdown leaves queued runs queued", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("sleep");
  const settings = ctx.store.getSettings();
  ctx.store.saveSettings({ ...settings, maxConcurrent: 1 });
  const first = ctx.runner.trigger(ctx.store.createJob(ctx.jobInput({ name: "A" }), null), "manual");
  const second = ctx.runner.trigger(ctx.store.createJob(ctx.jobInput({ name: "B" }), null), "manual");
  assert.ok("run" in first && "run" in second);
  await ctx.runner.shutdown();
  assert.equal(ctx.store.getRun(first.run.id)?.status, "failed");
  assert.equal(ctx.store.getRun(second.run.id)?.status, "queued");
});

test("scheduled fires skip while a run is active; queued runs can be canceled", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("sleep");
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const first = ctx.runner.trigger(job, "manual");
  assert.ok("run" in first);
  assert.deepEqual(ctx.runner.trigger(job, "schedule"), { skipped: "a run of this job is already queued or running" });

  const second = ctx.runner.trigger(job, "webhook", '{"bug": 1}');
  assert.ok("run" in second);
  assert.equal(ctx.store.getRun(second.run.id)?.status, "queued", "one run per job at a time");
  assert.equal(ctx.runner.cancel(second.run.id)?.status, "canceled");

  const finished = waitForFinish(ctx.runner, first.run.id);
  ctx.runner.cancel(first.run.id);
  await finished;
});

test("an unknown base ref fails the run cleanly", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("noop");
  const job = ctx.store.createJob(ctx.jobInput({ baseRef: "nope" }), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /git rev-parse failed/);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForFile(file: string): Promise<string> {
  while (!existsSync(file) || readFileSync(file, "utf8") === "") await new Promise((r) => setTimeout(r, 25));
  return readFileSync(file, "utf8");
}

test("processes the agent leaves behind are killed when it exits", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const pidFile = path.join(ctx.root, "orphan.pid");
  ctx.useFakeAgent(`orphan:${pidFile}`);
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false);
});

test("processes started in another session are found by the run marker and killed", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const pidFile = path.join(ctx.root, "detached.pid");
  ctx.useFakeAgent(`detached:${pidFile}`);
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false);
});

test("detached processes with no visible environment are found by their working directory", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const pidFile = path.join(ctx.root, "platform.pid");
  ctx.useFakeAgent(`platform:${pidFile}`);
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false);
});

test("cancel kills children that ignore SIGTERM", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const pidFile = path.join(ctx.root, "stubborn.pid");
  ctx.useFakeAgent(`stubborn:${pidFile}`);
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const pid = Number(await waitForFile(pidFile));
  const finished = waitForFinish(ctx.runner, result.run.id);
  ctx.runner.cancel(result.run.id);
  assert.equal((await finished).status, "canceled");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false);
});

test("a missing agent executable fails the run without crashing", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const settings = ctx.store.getSettings();
  settings.agents.pi.command = "/nonexistent/agent {prompt}";
  ctx.store.saveSettings(settings);
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /Could not start \/nonexistent\/agent: spawn \/nonexistent\/agent ENOENT/);
});

test("NUL bytes in a payload are stripped from the prompt", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("edit");
  const job = ctx.store.createJob(ctx.jobInput({ prompt: "Fix {{payload}}" }), null);
  const result = ctx.runner.trigger(job, "webhook", "bad\0byte");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded", run.error ?? "");
  assert.match(readFileSync(ctx.runner.logPath(run.id), "utf8"), /fake agent/);
});

/** An `origin` bare repo for ctx.repo, plus a second clone standing in for another machine. */
function withOrigin(ctx: ReturnType<typeof setup>) {
  const origin = path.join(ctx.root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", ctx.repo, origin]);
  git(ctx.repo, "remote", "add", "origin", origin);
  git(ctx.repo, "fetch", "-q", "origin");
  const laptop = path.join(ctx.root, "laptop");
  execFileSync("git", ["clone", "-q", origin, laptop]);
  return { origin, laptop };
}

test("runs start from the pushed tip of the base branch, not the local checkout", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const { laptop } = withOrigin(ctx);
  writeFileSync(path.join(laptop, "from-laptop.txt"), "pushed\n");
  git(laptop, "add", "-A");
  git(laptop, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "laptop work");
  git(laptop, "push", "-q", "origin", "main");
  const pushed = git(laptop, "rev-parse", "HEAD");

  ctx.useFakeAgent("noop");
  const job = ctx.store.createJob(ctx.jobInput(), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded", run.error ?? "");
  assert.equal(run.baseCommit, pushed);
  assert.notEqual(git(ctx.repo, "rev-parse", "main"), pushed, "the local checkout is not touched");
  assert.match(readFileSync(ctx.runner.logPath(run.id), "utf8"), /from origin\/main/);
});

test("pushBranch pushes a succeeded run's branch to origin", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const { origin } = withOrigin(ctx);
  ctx.useFakeAgent("edit");
  const job = ctx.store.createJob(ctx.jobInput({ pushBranch: true }), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "succeeded", run.error ?? "");
  assert.equal(run.pushedTo, "origin");
  assert.equal(git(origin, "rev-parse", run.branch!), run.headCommit);
});

test("a rejected push fails the run and keeps the worktree", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const { origin } = withOrigin(ctx);
  const hook = path.join(origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'rejected by policy' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  ctx.useFakeAgent("edit");
  const job = ctx.store.createJob(ctx.jobInput({ pushBranch: true }), null);
  const result = ctx.runner.trigger(job, "manual");
  assert.ok("run" in result);
  const run = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(run.status, "failed");
  assert.equal(run.pushedTo, null);
  assert.match(run.error ?? "", /Could not push .* rejected by policy/s);
  assert.ok(run.worktree && existsSync(run.worktree));
});

test("tags and revision expressions start from local refs without fetching; origin/<branch> is fetched", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const { laptop } = withOrigin(ctx);
  git(ctx.repo, "tag", "v1");
  writeFileSync(path.join(laptop, "pushed.txt"), "x\n");
  git(laptop, "add", "-A");
  git(laptop, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "pushed");
  git(laptop, "push", "-q", "origin", "main");
  ctx.useFakeAgent("noop");
  const runWith = async (baseRef: string) => {
    const job = ctx.store.createJob(ctx.jobInput({ name: `Base ${baseRef}`, baseRef }), null);
    const result = ctx.runner.trigger(job, "manual");
    assert.ok("run" in result);
    const run = await waitForFinish(ctx.runner, result.run.id);
    assert.equal(run.status, "succeeded", run.error ?? "");
    return { run, log: readFileSync(ctx.runner.logPath(run.id), "utf8") };
  };
  for (const ref of ["v1", "main~0"]) {
    const { run, log } = await runWith(ref);
    assert.equal(run.baseCommit, git(ctx.repo, "rev-parse", `${ref}^{commit}`));
    assert.doesNotMatch(log, /Could not fetch/);
  }
  const { run } = await runWith("origin/main");
  assert.equal(run.baseCommit, git(laptop, "rev-parse", "HEAD"));
});

test("a failed run is retried with backoff until the job's retries run out", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("fail");
  const job = ctx.store.createJob(ctx.jobInput({ retries: 2 }), null);
  const result = ctx.runner.trigger(job, "webhook", '{"bug": 1}');
  assert.ok("run" in result);
  const first = await waitForFinish(ctx.runner, result.run.id);
  assert.equal(first.status, "failed");

  const [second] = ctx.store.listRuns({ jobId: job.id, limit: 1 });
  assert.equal(second?.retryOf, first.id);
  assert.equal(second.attempt, 2);
  assert.equal(second.status, "queued");
  assert.equal(second.trigger, "webhook");
  assert.equal(second.payload, '{"bug": 1}');
  assert.ok(Date.parse(second.notBefore!) >= Date.parse(first.finishedAt!) + 100, "waits before retrying");
  assert.deepEqual(ctx.runner.trigger(job, "schedule"), { skipped: "a run of this job is already queued or running" });

  await waitForFinish(ctx.runner, second.id);
  const [third] = ctx.store.listRuns({ jobId: job.id, limit: 1 });
  assert.equal(third?.attempt, 3);
  assert.ok(Date.parse(third.notBefore!) - Date.parse(ctx.store.getRun(second.id)!.finishedAt!) >= 400, "backs off 4x");
  await waitForFinish(ctx.runner, third.id);
  assert.equal(ctx.store.listRuns({ jobId: job.id }).length, 3, "no retry after the last attempt");
});

test("canceled runs, failed checks and jobs without retries are not retried", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.useFakeAgent("edit");
  const checked = ctx.store.createJob(ctx.jobInput({ name: "Checked", retries: 2, checkCommand: "exit 1" }), null);
  const checkRun = ctx.runner.trigger(checked, "manual");
  assert.ok("run" in checkRun);
  assert.equal((await waitForFinish(ctx.runner, checkRun.run.id)).checkStatus, "failed");

  ctx.useFakeAgent("fail");
  const none = ctx.store.createJob(ctx.jobInput({ name: "None", retries: 0 }), null);
  const noneRun = ctx.runner.trigger(none, "manual");
  assert.ok("run" in noneRun);
  await waitForFinish(ctx.runner, noneRun.run.id);

  ctx.useFakeAgent("sleep");
  const canceled = ctx.store.createJob(ctx.jobInput({ name: "Canceled", retries: 2 }), null);
  const cancelRun = ctx.runner.trigger(canceled, "manual");
  assert.ok("run" in cancelRun);
  const finished = waitForFinish(ctx.runner, cancelRun.run.id);
  ctx.runner.cancel(cancelRun.run.id);
  assert.equal((await finished).status, "canceled");

  for (const job of [checked, none, canceled]) assert.equal(ctx.store.listRuns({ jobId: job.id }).length, 1, job.name);
});

test("runs interrupted by a server stop are retried", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const job = ctx.store.createJob(ctx.jobInput({ retries: 1 }), null);
  const run = ctx.store.createRun(job.id, "schedule", "pi", null);
  ctx.store.updateRun(run.id, { status: "running" });
  const [interrupted] = ctx.store.failInterruptedRuns();
  assert.equal(interrupted?.id, run.id);
  assert.equal(ctx.runner.retry(interrupted)?.retryOf, run.id);
  assert.equal(ctx.runner.retry({ ...interrupted, attempt: 2 }), null, "the job allows one retry");
});

test("a missed scheduled fire runs only when the job catches up", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const on = ctx.store.createJob(ctx.jobInput({ name: "On", schedule: "0 6 * * *" }), null);
  const off = ctx.store.createJob(ctx.jobInput({ name: "Off", schedule: "0 6 * * *", catchUp: false }), null);
  assert.deepEqual(ctx.runner.fireSchedule(off, true), { skipped: "its time was missed and catch-up is off" });
  assert.ok(ctx.store.getJob(off.id)?.lastFiredAt, "a skipped fire still counts as handled");
  const caught = ctx.runner.fireSchedule(on, true);
  assert.ok("run" in caught);
  assert.equal(caught.run.trigger, "schedule");
  ctx.runner.cancel(caught.run.id);
});
