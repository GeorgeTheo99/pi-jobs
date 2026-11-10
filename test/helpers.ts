import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Runner } from "../src/runner.ts";
import { Store, type JobInput, type Run } from "../src/store.ts";

export const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function makeRepo(root: string): string {
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return repo;
}

export function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-test-"));
  const repo = makeRepo(root);
  const store = new Store(path.join(root, "state", "pi-jobs.db"));
  const runner = new Runner({ store, stateDir: path.join(root, "state"), killGraceMs: 500, retryDelayMs: 100 });
  const useFakeAgent = (mode: string) => {
    const settings = store.getSettings();
    settings.agents.pi.command = `${process.execPath} ${FAKE_AGENT} ${mode} {prompt}`;
    store.saveSettings(settings);
  };
  const jobInput = (overrides: Partial<JobInput> = {}): JobInput => ({
    name: "Nightly check",
    repoPath: repo,
    baseRef: "main",
    prompt: "Do the thing",
    agent: null,
    schedule: null,
    timeoutMinutes: 5,
    checkCommand: null,
    pushBranch: false,
    catchUp: true,
    retries: 0,
    enabled: true,
    ...overrides,
  });
  const cleanup = async () => {
    await runner.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, store, runner, useFakeAgent, jobInput, cleanup };
}

export function waitForFinish(runner: Runner, runId: number): Promise<Run> {
  return new Promise((resolve) => {
    const onFinished = (run: Run) => {
      if (run.id !== runId) return;
      runner.off("finished", onFinished);
      resolve(run);
    };
    runner.on("finished", onFinished);
  });
}
