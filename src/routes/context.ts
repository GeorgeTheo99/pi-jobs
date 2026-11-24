import type { IncomingMessage } from "node:http";
import { AGENT_PRESETS, agentLabel, buildArgv, commandProgram, isBuiltinAgent, resolveExecutable, supportsSessions } from "../agents.ts";
import type { CallApi } from "../actions.ts";
import type { ChatRunner } from "../chat.ts";
import type { Config } from "../config.ts";
import { HttpError } from "../http.ts";
import type { Runner } from "../runner.ts";
import type { Scheduler } from "../scheduler.ts";
import { scanCheckouts, type Checkout } from "../repos.ts";
import type { ApiToken, Job, Run, Settings, Store } from "../store.ts";

export type Handler = (req: IncomingMessage, params: string[], url: URL) => Promise<unknown>;
export type Route = [method: string, pattern: RegExp, handler: Handler];

/** What every group of routes works with. */
export interface AppContext {
  config: Config;
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  chats: ChatRunner;
  /** The token each request signed in with. */
  sessions: WeakMap<IncomingMessage, ApiToken>;
  /** Checkouts under the repo roots, rescanned at most every 30 s. */
  checkouts: () => Promise<Checkout[]>;
  jobView: (job: Job, latest?: Run | null) => Job & { effectiveAgent: string; nextRunAt: string | null; lastRun: Run | null; webhookPath: string };
  findJob: (id: string | undefined) => Job;
  findRun: (id: string | undefined) => Run;
  settingsView: (settings: Settings) => Promise<unknown>;
  /** Calls a route in-process, as a chat action does; set once the routes exist. */
  callApi: CallApi;
}

export function createContext(base: Pick<AppContext, "config" | "store" | "runner" | "scheduler" | "chats">, envPath: string): AppContext {
  const { config, store, scheduler } = base;
  let checkoutCache: { at: number; checkouts: Promise<Checkout[]> } | null = null;
  return {
    ...base,
    sessions: new WeakMap(),
    checkouts: () => {
      if (!checkoutCache || Date.now() - checkoutCache.at > 30_000) {
        checkoutCache = { at: Date.now(), checkouts: scanCheckouts(config.repoRoots) };
      }
      return checkoutCache.checkouts;
    },
    jobView: (job, latest = store.latestRuns().get(job.id) ?? null) => ({
      ...job,
      effectiveAgent: job.agent ?? store.getSettings().defaultAgent,
      nextRunAt: scheduler.nextRun(job.id),
      lastRun: latest,
      webhookPath: `/api/hooks/${job.id}`,
    }),
    findJob: (id) => {
      const job = store.getJob(Number(id));
      if (!job) throw new HttpError(404, "Job not found");
      return job;
    },
    findRun: (id) => {
      const run = store.getRun(Number(id));
      if (!run) throw new HttpError(404, "Run not found");
      return run;
    },
    settingsView: async (settings) => ({
      ...settings,
      agentInfo: await Promise.all(
        Object.entries(settings.agents).map(async ([id, { command }]) => {
          let executable: string | null = null;
          try {
            executable = await resolveExecutable(commandProgram(buildArgv(command, "")), envPath);
          } catch {
            // Invalid commands are reported as unavailable.
          }
          const builtin = isBuiltinAgent(id);
          return { id, label: agentLabel(id), builtin, preset: builtin ? AGENT_PRESETS[id].command : null, executable, sessions: supportsSessions(command) };
        }),
      ),
    }),
    callApi: () => Promise.reject(new Error("callApi is set once the routes exist")),
  };
}
