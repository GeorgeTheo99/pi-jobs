export type AgentId = "pi" | "claude" | "codex";
export type Trigger = "manual" | "schedule" | "webhook";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "timed_out";

export const AGENT_LABELS: Record<AgentId, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };
export const AGENT_IDS = Object.keys(AGENT_LABELS) as AgentId[];
export const TRIGGER_LABELS: Record<Trigger, string> = { manual: "Manual", schedule: "Schedule", webhook: "Webhook" };

export interface Run {
  id: number;
  jobId: number;
  trigger: Trigger;
  status: RunStatus;
  agent: AgentId;
  payload: string | null;
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
  enabled: boolean;
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
  enabled: boolean;
}

export interface Settings {
  defaultAgent: AgentId;
  agents: Record<AgentId, { command: string }>;
  maxConcurrent: number;
  agentInfo: { id: AgentId; label: string; preset: string; executable: string | null }[];
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
  createToken: (name: string) => request<{ token: ApiToken; secret: string }>("POST", "/api/tokens", { name }),
  deleteToken: (id: number) => request<{ ok: true }>("DELETE", `/api/tokens/${id}`),
  jobs: () => request<Job[]>("GET", "/api/jobs"),
  job: (id: number) => request<Job>("GET", `/api/jobs/${id}`),
  createJob: (draft: JobDraft) => request<Job>("POST", "/api/jobs", draft),
  updateJob: (id: number, draft: JobDraft) => request<Job>("PUT", `/api/jobs/${id}`, draft),
  deleteJob: (id: number) => request<{ ok: true }>("DELETE", `/api/jobs/${id}`),
  runJob: (id: number) => request<Run>("POST", `/api/jobs/${id}/run`),
  rotateToken: (id: number) => request<Job>("POST", `/api/jobs/${id}/webhook-token`),
  runs: (jobId?: number, limit = 100) =>
    request<Run[]>("GET", `/api/runs?limit=${limit}${jobId === undefined ? "" : `&jobId=${jobId}`}`),
  run: (id: number) => request<Run>("GET", `/api/runs/${id}`),
  log: (id: number, offset: number) => request<LogChunk>("GET", `/api/runs/${id}/log?offset=${offset}`),
  cancelRun: (id: number) => request<Run>("POST", `/api/runs/${id}/cancel`),
  settings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (settings: Omit<Settings, "agentInfo">) => request<Settings>("PUT", "/api/settings", settings),
  schedulePreview: (expression: string) =>
    request<SchedulePreview>("GET", `/api/schedule-preview?expression=${encodeURIComponent(expression)}`),
};

export const isActive = (status: RunStatus) => status === "queued" || status === "running";

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
    enabled: job.enabled,
  };
}
