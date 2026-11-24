/** A built-in agent (pi, claude, codex) or one added in Settings by name, such as "pi-claude". */
export type AgentId = string;
export type Trigger = "manual" | "schedule" | "webhook" | "watch";
/**
 * A change run may commit to a branch; an ask run only answers, and its checkout is discarded. A
 * ship run runs the job's ship command (no agent) on the item's result; a release run has the agent
 * release it by the job's release instructions.
 */
export type RunMode = "change" | "ask" | "ship" | "release";
/** Runs that release an item: its agent, or its release script ("ship"). */
export const isReleaseMode = (mode: RunMode) => mode === "ship" || mode === "release";
export type RunStatus = "awaiting_approval" | "queued" | "running" | "succeeded" | "failed" | "canceled" | "timed_out";

const BUILTIN_LABELS: Record<string, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };
/** A built-in agent's label, or an added agent's name. */
export const agentLabel = (id: AgentId): string => (Object.hasOwn(BUILTIN_LABELS, id) ? BUILTIN_LABELS[id]! : id);
export const TRIGGER_LABELS: Record<Trigger, string> = {
  manual: "Manual",
  schedule: "Schedule",
  webhook: "Webhook",
  watch: "Watch",
};

export interface Run {
  id: number;
  jobId: number;
  trigger: Trigger;
  status: RunStatus;
  agent: AgentId;
  payload: string | null;
  /** 1 for the first try; retries count up from there. */
  attempt: number;
  retryOf: number | null;
  /** A queued retry waits until this time. */
  notBefore: string | null;
  /** The finished run this one follows up on, starting from its result. */
  followUpOf: number | null;
  /** A follow-up's instructions, which take the place of the job's. */
  instructions: string | null;
  mode: RunMode;
  /** The first run of this run's item. */
  itemId: number;
  /** The agent session the item's runs continue; null for agents without sessions. */
  sessionId: string | null;
  /** The agent's final report (Markdown). Only single-run responses carry it; lists have summaryHeadline. */
  summary?: string | null;
  /** The report's first line as plain text. */
  summaryHeadline?: string | null;
  /** The report's "Verdict: …" line, when it has one. */
  summaryVerdict?: string | null;
  /** The run's commits are in its job's base branch. Absent on runs returned by actions. */
  merged?: boolean;
  repliedAt: string | null;
  closedAt: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  commits: number | null;
  exitCode: number | null;
  checkStatus: "passed" | "failed" | null;
  pushedTo: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Job {
  id: number;
  name: string;
  repoPath: string;
  baseRef: string;
  prompt: string;
  agent: AgentId | null;
  schedule: string | null;
  webhookToken: string | null;
  timeoutMinutes: number;
  checkCommand: string | null;
  pushBranch: boolean;
  catchUp: boolean;
  retries: number;
  watchCommand: string | null;
  approveRuns: boolean;
  /** The release script run on an item's result; null without one. */
  shipCommand: string | null;
  /** What the agent follows to release an item's result; null when it doesn't. */
  releaseInstructions: string | null;
  /** Release each result that succeeds with changes, without waiting for the owner. */
  autoRelease: boolean;
  enabled: boolean;
  lastFiredAt: string | null;
  watchCheckedAt: string | null;
  watchError: string | null;
  createdAt: string;
  updatedAt: string;
  effectiveAgent: AgentId;
  nextRunAt: string | null;
  lastRun: Run | null;
  webhookPath: string;
}

export interface JobDraft {
  name: string;
  repoPath: string;
  baseRef: string;
  prompt: string;
  agent: AgentId | null;
  schedule: string;
  webhookEnabled: boolean;
  timeoutMinutes: number;
  checkCommand: string;
  pushBranch: boolean;
  catchUp: boolean;
  retries: number;
  watchCommand: string;
  approveRuns: boolean;
  shipCommand: string;
  releaseInstructions: string;
  autoRelease: boolean;
  enabled: boolean;
}

export type ChatTurnStatus = "running" | "succeeded" | "failed" | "canceled";
export type ChatActionStatus = "proposed" | "applied" | "failed" | "dismissed" | "invalid";

/** A change the chat's agent proposed; nothing happens until the owner applies it. */
export interface ChatAction {
  type: string;
  args: Record<string, unknown>;
  title: string;
  /** Exact before/after values of what it changes. */
  changes: { field: string; before: unknown; after: unknown }[];
  /** Shown in full and applied one at a time, never with Apply all. */
  risky: boolean;
  basis: string | null;
  status: ChatActionStatus;
  result: string | null;
  error: string | null;
}

export interface ChatTurn {
  id: number;
  chatId: number;
  message: string;
  reply: string | null;
  actions: ChatAction[];
  status: ChatTurnStatus;
  error: string | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Chat {
  id: number;
  title: string;
  jobId: number | null;
  runId: number | null;
  agent: AgentId;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  /** A reply is being written. */
  busy: boolean;
}

export interface ChatWithTurns extends Chat {
  turns: ChatTurn[];
}

export interface ChatSummary extends Chat {
  lastTurn: ChatTurn | null;
}

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface RunChanges {
  from: string;
  to: string;
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
}

export interface WatchResult {
  runs: Run[];
  seen: number;
  error: string | null;
}

export interface Settings {
  defaultAgent: AgentId;
  agents: Record<AgentId, { command: string }>;
  maxConcurrent: number;
  /** Every agent in `agents`, in order: built-ins first. */
  agentInfo: { id: AgentId; label: string; builtin: boolean; preset: string | null; executable: string | null; sessions: boolean }[];
}

export interface LogChunk {
  text: string;
  offset: number;
  size: number;
  done: boolean;
}

export interface SchedulePreview {
  valid: boolean;
  error: string | null;
  next: string[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;
  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/**
 * Resolves an app path like "/api/jobs" against the document's <base href>, which the server sets
 * to the proxy prefix (e.g. "/pi-jobs/") when the app is served behind Caddy.
 */
export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), document.baseURI).href;
}

const TOKEN_KEY = "pi-jobs-token";
export const AUTH_REQUIRED_EVENT = "pi-jobs:auth-required";
/** Fired after any change the server accepted, so every view of runs (the nav badge too) refreshes at once. */
export const CHANGED_EVENT = "pi-jobs:changed";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request<T>(method: string, path: string, body?: unknown, token = tokenStore.get()): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== "GET") headers["content-type"] = "application/json";
  const res = await fetch(apiUrl(path), {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.fields);
  if (method !== "GET") window.dispatchEvent(new Event(CHANGED_EVENT));
  return data as T;
}

export interface ApiToken {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const api = {
  /** Checks a token without storing it. */
  session: (token?: string) => request<{ token: ApiToken }>("GET", "/api/session", undefined, token ?? tokenStore.get()),
  tokens: () => request<ApiToken[]>("GET", "/api/tokens"),
  /** `token` is optional: an owner-chosen token instead of a generated one. */
  createToken: (name: string, token?: string) =>
    request<{ token: ApiToken; secret: string }>("POST", "/api/tokens", token ? { name, token } : { name }),
  deleteToken: (id: number) => request<{ ok: true }>("DELETE", `/api/tokens/${id}`),
  jobs: () => request<Job[]>("GET", "/api/jobs"),
  job: (id: number) => request<Job>("GET", `/api/jobs/${id}`),
  createJob: (draft: JobDraft) => request<Job>("POST", "/api/jobs", draft),
  updateJob: (id: number, draft: JobDraft) => request<Job>("PUT", `/api/jobs/${id}`, draft),
  deleteJob: (id: number) => request<{ ok: true }>("DELETE", `/api/jobs/${id}`),
  runJob: (id: number) => request<Run>("POST", `/api/jobs/${id}/run`),
  checkWatch: (id: number) => request<WatchResult>("POST", `/api/jobs/${id}/watch`),
  rotateToken: (id: number) => request<Job>("POST", `/api/jobs/${id}/webhook-token`),
  runs: (jobId?: number, limit = 100) =>
    request<Run[]>("GET", `/api/runs?limit=${limit}${jobId === undefined ? "" : `&jobId=${jobId}`}`),
  run: (id: number) => request<Run>("GET", `/api/runs/${id}`),
  log: (id: number, offset: number) => request<LogChunk>("GET", `/api/runs/${id}/log?offset=${offset}`),
  cancelRun: (id: number) => request<Run>("POST", `/api/runs/${id}/cancel`),
  approveRun: (id: number) => request<Run>("POST", `/api/runs/${id}/approve`),
  followUp: (id: number, instructions: string, mode: RunMode = "change") =>
    request<Run>("POST", `/api/runs/${id}/follow-up`, { instructions, mode }),
  /** Releases the run's item: the job's agent by its release instructions, or its release script. */
  release: (id: number) => request<Run>("POST", `/api/runs/${id}/release`),
  /** Every run of the run's item, oldest first, with their reports. */
  thread: (id: number) => request<Run[]>("GET", `/api/runs/${id}/thread`),
  changes: (id: number, sinceBase = false) => request<RunChanges>("GET", `/api/runs/${id}/changes${sinceBase ? "?since=base" : ""}`),
  markReplied: (id: number, value: boolean) => request<Run>("POST", `/api/runs/${id}/replied`, { value }),
  markClosed: (id: number, value: boolean) => request<Run>("POST", `/api/runs/${id}/closed`, { value }),
  checkWatches: () => request<{ jobId: number; started: number; error: string | null }[]>("POST", "/api/watches/check"),
  chats: () => request<ChatSummary[]>("GET", "/api/chats"),
  chat: (id: number) => request<ChatWithTurns>("GET", `/api/chats/${id}`),
  /** Starts a chat, optionally about a job or an item (any of its runs), with its first message. */
  createChat: (message: string, about: { jobId?: number; runId?: number; agent?: AgentId } = {}) =>
    request<ChatWithTurns>("POST", "/api/chats", { message, ...about }),
  sendChat: (id: number, message: string) => request<ChatWithTurns>("POST", `/api/chats/${id}/messages`, { message }),
  cancelChat: (id: number) => request<ChatWithTurns>("POST", `/api/chats/${id}/cancel`),
  deleteChat: (id: number) => request<{ ok: true }>("DELETE", `/api/chats/${id}`),
  chatLog: (id: number, turnId: number, offset: number) => request<LogChunk>("GET", `/api/chats/${id}/turns/${turnId}/log?offset=${offset}`),
  /** Applies or dismisses a proposed action; `secret` (a new token) comes only in this response. */
  decideAction: (id: number, turnId: number, index: number, decision: "apply" | "dismiss") =>
    request<{ action: ChatAction; secret?: string }>("POST", `/api/chats/${id}/turns/${turnId}/actions/${index}`, { decision }),
  settings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (settings: Omit<Settings, "agentInfo">) => request<Settings>("PUT", "/api/settings", settings),
  schedulePreview: (expression: string) =>
    request<SchedulePreview>("GET", `/api/schedule-preview?expression=${encodeURIComponent(expression)}`),
};

export const isActive = (status: RunStatus) =>
  status === "awaiting_approval" || status === "queued" || status === "running";

export function jobToDraft(job: Job): JobDraft {
  return {
    name: job.name,
    repoPath: job.repoPath,
    baseRef: job.baseRef,
    prompt: job.prompt,
    agent: job.agent,
    schedule: job.schedule ?? "",
    webhookEnabled: job.webhookToken !== null,
    timeoutMinutes: job.timeoutMinutes,
    checkCommand: job.checkCommand ?? "",
    pushBranch: job.pushBranch,
    catchUp: job.catchUp,
    retries: job.retries,
    watchCommand: job.watchCommand ?? "",
    approveRuns: job.approveRuns,
    shipCommand: job.shipCommand ?? "",
    releaseInstructions: job.releaseInstructions ?? "",
    autoRelease: job.autoRelease,
    enabled: job.enabled,
  };
}
