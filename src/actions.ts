import { isBuiltinAgent } from "./agents.ts";
import type { ChatAction, Job, Run, Settings, Store } from "./store.ts";

/**
 * What a chat's agent may propose. Each action is one call to pi-jobs' own API, made only when the
 * owner applies it, so it gets the same validation as the UI's buttons. Applying never hands a
 * secret back to the agent: token values reach the owner's card only.
 */

/** An API request, made in-process through the app's routes. */
export interface ApiCall {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}
export type CallApi = (call: ApiCall) => Promise<unknown>;

/** The proposal is malformed or its target is gone. */
export class ActionError extends Error {}

/** A chat's actions per turn beyond this are refused. */
export const MAX_ACTIONS = 20;

/** Fields an action may set on a job, in the order cards show them. */
const JOB_FIELDS = [
  "name",
  "repoPath",
  "baseRef",
  "prompt",
  "agent",
  "schedule",
  "webhookEnabled",
  "timeoutMinutes",
  "retries",
  "catchUp",
  "checkCommand",
  "pushBranch",
  "watchCommand",
  "approveRuns",
  "shipCommand",
  "releaseInstructions",
  "verifyCommand",
  "autoRelease",
  "enabled",
] as const;
type JobField = (typeof JOB_FIELDS)[number];

/** Changing these runs commands, publishes branches, opens a webhook or moves the job: always shown in full and applied alone. */
const RISKY_JOB_FIELDS: ReadonlySet<JobField> = new Set([
  "repoPath",
  "checkCommand",
  "watchCommand",
  "shipCommand",
  "releaseInstructions",
  "verifyCommand",
  "autoRelease",
  "pushBranch",
  "webhookEnabled",
]);

interface Plan {
  title: string;
  changes: ChatAction["changes"];
  risky: boolean;
  basis: string | null;
}

interface Definition {
  /** The action's arguments and effect, for the agent's prompt. */
  help: string;
  /** Checks the arguments against the current state and says what applying would do. */
  plan(args: Record<string, unknown>, store: Store): Plan;
  request(args: Record<string, unknown>, store: Store): ApiCall;
  /** What applying did; `secret` goes to the owner's card only. */
  outcome(response: unknown, args: Record<string, unknown>): { text: string; secret?: string };
}

function intArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ActionError(`${name} must be a positive integer`);
  return value;
}

function boolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name] ?? fallback;
  if (typeof value !== "boolean") throw new ActionError(`${name} must be true or false`);
  return value;
}

function findJob(args: Record<string, unknown>, store: Store): Job {
  const id = intArg(args, "jobId");
  const job = store.getJob(id);
  if (!job) throw new ActionError(`Job #${id} doesn't exist`);
  return job;
}

function findRun(args: Record<string, unknown>, store: Store): Run {
  const id = intArg(args, "runId");
  const run = store.getRun(id);
  if (!run) throw new ActionError(`Run #${id} doesn't exist`);
  return run;
}

/** A job's settings as the API's job body. */
export function jobBody(job: Job): Record<JobField, unknown> {
  return {
    name: job.name,
    repoPath: job.repoPath,
    baseRef: job.baseRef,
    prompt: job.prompt,
    agent: job.agent,
    schedule: job.schedule ?? "",
    webhookEnabled: job.webhookToken !== null,
    timeoutMinutes: job.timeoutMinutes,
    retries: job.retries,
    catchUp: job.catchUp,
    checkCommand: job.checkCommand ?? "",
    pushBranch: job.pushBranch,
    watchCommand: job.watchCommand ?? "",
    approveRuns: job.approveRuns,
    shipCommand: job.shipCommand ?? "",
    releaseInstructions: job.releaseInstructions ?? "",
    verifyCommand: job.verifyCommand ?? "",
    autoRelease: job.autoRelease,
    enabled: job.enabled,
  };
}

/** The job fields an action sets, refusing unknown ones; the API validates their values. */
function jobFields(value: unknown, name: string): Partial<Record<JobField, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ActionError(`${name} must be an object of job fields`);
  const unknown = Object.keys(value).filter((key) => !(JOB_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new ActionError(`Unknown job field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  const fields = value as Partial<Record<JobField, unknown>>;
  if (fields.agent !== undefined && fields.agent !== null && typeof fields.agent !== "string") {
    throw new ActionError("agent must be null (the default) or the name of an agent in Settings");
  }
  return fields;
}

/** Empty strings and null both mean "none" for a job's optional text fields. */
const same = (a: unknown, b: unknown) => (a ?? "") === (b ?? "");

const label = (job: Job) => `job #${job.id} "${job.name}"`;

const updateJobTitle = (job: Job, changed: JobField[], fields: Partial<Record<JobField, unknown>>): string => {
  if (changed.length === 1 && changed[0] === "enabled") return `${fields.enabled ? "Resume" : "Pause"} ${label(job)}`;
  return `Change ${label(job)}: ${changed.join(", ")}`;
};

function runLabel(run: Run, store: Store): string {
  const job = store.getJob(run.jobId);
  return `run #${run.id}${job ? ` of ${label(job)}` : ""}`;
}

const settingsBody = (settings: Settings) => ({
  defaultAgent: settings.defaultAgent,
  agents: settings.agents,
  maxConcurrent: settings.maxConcurrent,
});

function settingsChanges(args: Record<string, unknown>, settings: Settings) {
  const value = args.changes;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ActionError("changes must be an object");
  const { defaultAgent, maxConcurrent, agents, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new ActionError(`Unknown setting: ${Object.keys(rest).join(", ")}`);
  const next = structuredClone(settingsBody(settings)) as ReturnType<typeof settingsBody>;
  const changes: ChatAction["changes"] = [];
  if (defaultAgent !== undefined) {
    if (typeof defaultAgent !== "string") throw new ActionError("defaultAgent must be the name of an agent");
    if (defaultAgent !== settings.defaultAgent) changes.push({ field: "defaultAgent", before: settings.defaultAgent, after: defaultAgent });
    next.defaultAgent = defaultAgent;
  }
  if (maxConcurrent !== undefined) {
    if (maxConcurrent !== settings.maxConcurrent) changes.push({ field: "maxConcurrent", before: settings.maxConcurrent, after: maxConcurrent });
    next.maxConcurrent = maxConcurrent as number;
  }
  if (agents !== undefined) {
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) throw new ActionError("agents must map agent ids to {command} (or null to remove one)");
    for (const [id, entry] of Object.entries(agents)) {
      const before = Object.hasOwn(settings.agents, id) ? settings.agents[id]!.command : null;
      if (entry === null) {
        if (isBuiltinAgent(id)) throw new ActionError(`The built-in agent ${id} can't be removed`);
        if (before === null) throw new ActionError(`There is no agent named ${id}`);
        changes.push({ field: `agents.${id}`, before, after: null });
        delete next.agents[id];
        continue;
      }
      const command = (entry as { command?: unknown }).command;
      if (typeof command !== "string") throw new ActionError(`agents.${id}.command must be a string`);
      if (command !== before) changes.push({ field: `agents.${id}.command`, before, after: command });
      next.agents[id] = { command };
    }
  }
  if (changes.length === 0) throw new ActionError("These settings are already in place");
  return { next, changes };
}

const watchSummary = (response: unknown) => {
  const result = response as { runs: Run[]; seen: number; error: string | null };
  const started = result.runs.length ? `started run${result.runs.length > 1 ? "s" : ""} ${result.runs.map((r) => `#${r.id}`).join(", ")}` : "no new items";
  return `Checked the watch: ${started}${result.error ? `; ${result.error}` : ""}`;
};

const DEFINITIONS: Record<string, Definition> = {
  create_job: {
    help: `create_job {"job": {name, repoPath, prompt, ...optional job fields}}: a new job. Job fields: ${JOB_FIELDS.join(", ")}.`,
    plan(args) {
      const fields = jobFields(args.job, "job");
      const changed = JOB_FIELDS.filter((field) => fields[field] !== undefined);
      return {
        title: `Create job "${String(fields.name ?? "")}"`,
        changes: changed.map((field) => ({ field, before: null, after: fields[field] })),
        // A new job names its repository, which isn't a move: only commands, pushes and webhooks count.
        risky: changed.some((field) => field !== "repoPath" && RISKY_JOB_FIELDS.has(field) && fields[field] !== "" && fields[field] !== false),
        basis: null,
      };
    },
    request: (args) => ({ method: "POST", path: "/api/jobs", body: jobFields(args.job, "job") }),
    outcome: (response) => {
      const job = response as Job;
      return { text: `Created job #${job.id} "${job.name}"` };
    },
  },
  update_job: {
    help: `update_job {"jobId", "changes": {job fields}}: change a job; only the given fields change. Pause with {"enabled": false}.`,
    plan(args, store) {
      const job = findJob(args, store);
      const fields = jobFields(args.changes, "changes");
      const before = jobBody(job);
      const changed = JOB_FIELDS.filter((field) => fields[field] !== undefined && !same(before[field], fields[field]));
      if (changed.length === 0) throw new ActionError(`${label(job)} already has these settings`);
      return {
        title: updateJobTitle(job, changed, fields),
        changes: changed.map((field) => ({ field, before: before[field], after: fields[field] })),
        risky: changed.some((field) => RISKY_JOB_FIELDS.has(field)),
        basis: job.updatedAt,
      };
    },
    request(args, store) {
      const job = findJob(args, store);
      return { method: "PUT", path: `/api/jobs/${job.id}`, body: { ...jobBody(job), ...jobFields(args.changes, "changes") } };
    },
    outcome: (response) => {
      const job = response as Job;
      return { text: `Saved job #${job.id} "${job.name}"` };
    },
  },
  delete_job: {
    help: `delete_job {"jobId"}: delete a job and its run history (its branches stay).`,
    plan(args, store) {
      const job = findJob(args, store);
      return { title: `Delete ${label(job)} and its run history`, changes: [], risky: true, basis: job.updatedAt };
    },
    request: (args, store) => ({ method: "DELETE", path: `/api/jobs/${findJob(args, store).id}` }),
    outcome: (_response, args) => ({ text: `Deleted job #${String(args.jobId)}` }),
  },
  run_job: {
    help: `run_job {"jobId"}: Run now.`,
    plan(args, store) {
      const job = findJob(args, store);
      return { title: `Run ${label(job)} now`, changes: [], risky: false, basis: null };
    },
    request: (args, store) => ({ method: "POST", path: `/api/jobs/${findJob(args, store).id}/run` }),
    outcome: (response) => ({ text: `Started run #${(response as Run).id}` }),
  },
  check_watch: {
    help: `check_watch {"jobId"}: run a watch job's watch command now.`,
    plan(args, store) {
      const job = findJob(args, store);
      if (!job.watchCommand) throw new ActionError(`${label(job)} has no watch command`);
      return { title: `Check ${label(job)}'s watch now`, changes: [], risky: false, basis: null };
    },
    request: (args, store) => ({ method: "POST", path: `/api/jobs/${findJob(args, store).id}/watch` }),
    outcome: (response) => ({ text: watchSummary(response) }),
  },
  rotate_webhook_token: {
    help: `rotate_webhook_token {"jobId"}: replace a job's webhook token; callers using the old one stop working. The new token is shown to the owner only.`,
    plan(args, store) {
      const job = findJob(args, store);
      if (!job.webhookToken) throw new ActionError(`${label(job)}'s webhook is off`);
      return { title: `Replace ${label(job)}'s webhook token`, changes: [], risky: true, basis: job.updatedAt };
    },
    request: (args, store) => ({ method: "POST", path: `/api/jobs/${findJob(args, store).id}/webhook-token` }),
    outcome: (response) => ({ text: "Replaced the webhook token (shown once on this card)", secret: (response as Job).webhookToken ?? undefined }),
  },
  follow_up: {
    help: `follow_up {"runId", "instructions", "mode": "change" | "ask"}: continue an item (any of its runs): Make changes, or Ask a question.`,
    plan(args, store) {
      const run = findRun(args, store);
      if (typeof args.instructions !== "string" || !args.instructions.trim()) throw new ActionError("instructions must say what the agent should do");
      const mode = args.mode ?? "change";
      if (mode !== "change" && mode !== "ask") throw new ActionError('mode must be "change" or "ask"');
      return {
        title: `${mode === "ask" ? "Ask about" : "Make changes on"} ${runLabel(run, store)}'s item`,
        changes: [{ field: "instructions", before: null, after: args.instructions.trim() }],
        risky: false,
        basis: null,
      };
    },
    request(args, store) {
      // The item's newest run, which the UI's composer follows up on too.
      const latest = store.itemRuns(findRun(args, store).itemId).at(-1)!;
      return { method: "POST", path: `/api/runs/${latest.id}/follow-up`, body: { instructions: args.instructions, mode: args.mode ?? "change" } };
    },
    outcome: (response) => ({ text: `Started run #${(response as Run).id}` }),
  },
  approve_run: {
    help: `approve_run {"runId"}: approve a run waiting for approval.`,
    plan(args, store) {
      const run = findRun(args, store);
      if (run.status !== "awaiting_approval") throw new ActionError(`Run #${run.id} isn't waiting for approval (it is ${run.status})`);
      return { title: `Approve ${runLabel(run, store)}`, changes: [], risky: false, basis: null };
    },
    request: (args, store) => ({ method: "POST", path: `/api/runs/${findRun(args, store).id}/approve` }),
    outcome: (response) => ({ text: `Approved run #${(response as Run).id}` }),
  },
  cancel_run: {
    help: `cancel_run {"runId"}: dismiss a run waiting for approval, cancel a queued one or stop a running one.`,
    plan(args, store) {
      const run = findRun(args, store);
      if (!["awaiting_approval", "queued", "running"].includes(run.status)) throw new ActionError(`Run #${run.id} has already finished`);
      const verb = run.status === "awaiting_approval" ? "Dismiss" : run.status === "queued" ? "Cancel" : "Stop";
      return { title: `${verb} ${runLabel(run, store)}`, changes: [], risky: false, basis: null };
    },
    request: (args, store) => ({ method: "POST", path: `/api/runs/${findRun(args, store).id}/cancel` }),
    outcome: (response) => ({ text: `Run #${(response as Run).id}: ${(response as Run).status}` }),
  },
  release: {
    help: `release {"runId"}: release the item's result (any run of the item): the job's agent follows its release instructions, or its ship command runs.`,
    plan(args, store) {
      const run = findRun(args, store);
      const job = store.getJob(run.jobId);
      if (!job?.releaseInstructions && !job?.shipCommand) throw new ActionError("This job has no release instructions or ship command");
      return {
        title: `Release ${runLabel(run, store)}'s item`,
        changes: job.releaseInstructions
          ? [{ field: "releaseInstructions", before: null, after: job.releaseInstructions }]
          : [{ field: "shipCommand", before: null, after: job.shipCommand }],
        risky: true,
        basis: job.updatedAt,
      };
    },
    request: (args, store) => ({ method: "POST", path: `/api/runs/${findRun(args, store).id}/release` }),
    outcome: (response) => ({ text: `Started release run #${(response as Run).id}` }),
  },
  close_item: {
    help: `close_item {"runId", "closed": true | false}: close an item without merging, or reopen it.`,
    plan(args, store) {
      const run = findRun(args, store);
      const closed = boolArg(args, "closed", true);
      return { title: `${closed ? "Close" : "Reopen"} ${runLabel(run, store)}'s item`, changes: [], risky: false, basis: null };
    },
    request(args, store) {
      // Closing acts on the item's newest work, as in the UI.
      const runs = store.itemRuns(findRun(args, store).itemId);
      const work = runs.filter((r) => r.mode !== "ask").at(-1) ?? runs.at(-1)!;
      return { method: "POST", path: `/api/runs/${work.id}/closed`, body: { value: boolArg(args, "closed", true) } };
    },
    outcome: (_response, args) => ({ text: boolArg(args, "closed", true) ? "Closed the item" : "Reopened the item" }),
  },
  mark_replied: {
    help: `mark_replied {"runId", "replied": true | false}: mark an item's reporter replied to (pi-jobs never sends replies).`,
    plan(args, store) {
      const run = findRun(args, store);
      const replied = boolArg(args, "replied", true);
      return { title: `Mark ${runLabel(run, store)}'s item ${replied ? "replied" : "not replied"}`, changes: [], risky: false, basis: null };
    },
    request: (args, store) => ({ method: "POST", path: `/api/runs/${findRun(args, store).id}/replied`, body: { value: boolArg(args, "replied", true) } }),
    outcome: (_response, args) => ({ text: boolArg(args, "replied", true) ? "Marked replied" : "Marked not replied" }),
  },
  update_settings: {
    help: `update_settings {"changes": {"defaultAgent"?, "maxConcurrent"?, "agents"?: {"<agent id>": {"command"} | null}}}: change Settings. Agents are pi, claude, codex and any added by name (another Pi launcher such as "pi-claude"); a new name adds one, null removes an added one.`,
    plan(args, store) {
      const settings = store.getSettings();
      const { changes } = settingsChanges(args, settings);
      return {
        title: `Change settings: ${changes.map((c) => c.field).join(", ")}`,
        changes,
        risky: changes.some((c) => c.field.startsWith("agents.")),
        basis: JSON.stringify(settingsBody(settings)),
      };
    },
    request: (args, store) => ({ method: "PUT", path: "/api/settings", body: settingsChanges(args, store.getSettings()).next }),
    outcome: () => ({ text: "Saved settings" }),
  },
  create_token: {
    help: `create_token {"name"}: a new API token; its value is shown to the owner only, never to you.`,
    plan(args) {
      if (typeof args.name !== "string" || !args.name.trim()) throw new ActionError("name is required");
      if (args.token !== undefined) throw new ActionError("Tokens are generated; never choose or repeat a token value");
      return { title: `Create API token "${args.name.trim()}"`, changes: [], risky: true, basis: null };
    },
    request: (args) => ({ method: "POST", path: "/api/tokens", body: { name: String(args.name).trim() } }),
    outcome: (response) => {
      const created = response as { token: { name: string }; secret: string };
      return { text: `Created API token "${created.token.name}" (shown once on this card)`, secret: created.secret };
    },
  },
  revoke_token: {
    help: `revoke_token {"name"}: revoke an API token; anything using it loses access.`,
    plan(args, store) {
      const token = store.listTokens().find((t) => t.name === args.name);
      if (!token) throw new ActionError(`No API token is named ${JSON.stringify(args.name)}`);
      return { title: `Revoke API token "${token.name}"`, changes: [], risky: true, basis: String(token.id) };
    },
    request(args, store) {
      const token = store.listTokens().find((t) => t.name === args.name);
      if (!token) throw new ActionError(`No API token is named ${JSON.stringify(args.name)}`);
      return { method: "DELETE", path: `/api/tokens/${token.id}` };
    },
    outcome: (_response, args) => ({ text: `Revoked API token "${String(args.name)}"` }),
  },
};

// The name from before releases; agents that learned it still get a card.
const ALIASES: Record<string, string> = { ship: "release" };

export const ACTION_TYPES = Object.keys(DEFINITIONS);

/** One line per action type, for the agent's prompt. */
export function actionHelp(): string {
  return Object.values(DEFINITIONS)
    .map((definition) => `- ${definition.help}`)
    .join("\n");
}

/** Turns what the agent proposed into an action card: planned against the current state, or invalid with the reason. */
export function planAction(proposal: unknown, store: Store): ChatAction {
  const record = proposal && typeof proposal === "object" && !Array.isArray(proposal) ? (proposal as Record<string, unknown>) : null;
  const type = typeof record?.type === "string" ? record.type : "";
  const { type: _type, ...args } = record ?? {};
  const base: ChatAction = { type, args, title: type || "Unreadable action", changes: [], risky: false, basis: null, status: "proposed", result: null, error: null };
  const definition = DEFINITIONS[ALIASES[type] ?? type];
  if (!definition) return { ...base, status: "invalid", error: `Unknown action type ${JSON.stringify(type)}` };
  try {
    return { ...base, ...definition.plan(args, store) };
  } catch (error) {
    if (!(error instanceof ActionError)) throw error;
    return { ...base, status: "invalid", error: error.message };
  }
}

/**
 * Applies a proposed action through the API, if its target hasn't changed since it was proposed.
 * Returns the action as applied or failed, and a secret for the owner's card when it made one.
 */
export async function applyAction(action: ChatAction, store: Store, callApi: CallApi): Promise<{ action: ChatAction; secret?: string }> {
  const definition = DEFINITIONS[ALIASES[action.type] ?? action.type];
  try {
    if (!definition) throw new ActionError(`Unknown action type ${JSON.stringify(action.type)}`);
    const now = definition.plan(action.args, store);
    if (now.basis !== action.basis) throw new ActionError("Its target changed since this was proposed; ask again for an up-to-date proposal");
    const response = await callApi(definition.request(action.args, store));
    const { text, secret } = definition.outcome(response, action.args);
    return { action: { ...action, status: "applied", result: text, error: null }, ...(secret ? { secret } : {}) };
  } catch (error) {
    return { action: { ...action, status: "failed", error: errorText(error) } };
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const fields = (error as { fields?: Record<string, string> }).fields;
  return fields ? `${error.message}: ${Object.entries(fields).map(([field, message]) => `${field}: ${message}`).join("; ")}` : error.message;
}
