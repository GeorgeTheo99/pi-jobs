import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AGENT_IDS, AGENT_PRESETS, isAgentId, type AgentId } from "./agents.ts";

export type Trigger = "manual" | "schedule" | "webhook";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "timed_out";
export const ACTIVE_STATUSES: readonly RunStatus[] = ["queued", "running"];

export interface JobInput {
  name: string;
  repoPath: string;
  baseRef: string;
  prompt: string;
  /** Null means "use the default agent from settings". */
  agent: AgentId | null;
  /** Cron expression, or null for manual/webhook-only jobs. */
  schedule: string | null;
  timeoutMinutes: number;
  checkCommand: string | null;
  /** Push a succeeded run's branch to the repo's `origin` remote. */
  pushBranch: boolean;
  /** Run once after scheduled fires were missed while the server was down or asleep. */
  catchUp: boolean;
  /** Times a failed or timed-out run is retried. */
  retries: number;
  enabled: boolean;
}

export interface Job extends JobInput {
  id: number;
  /** Null means the webhook trigger is off. */
  webhookToken: string | null;
  /** When the schedule last fired (or a missed fire was handled). */
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: number;
  jobId: number;
  trigger: Trigger;
  status: RunStatus;
  agent: AgentId;
  payload: string | null;
  /** 1 for the first try; retries count up from there. */
  attempt: number;
  /** The run this one retries. */
  retryOf: number | null;
  /** A queued retry waits until this time. */
  notBefore: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  commits: number | null;
  exitCode: number | null;
  checkStatus: "passed" | "failed" | null;
  /** Remote the branch was pushed to, or null. */
  pushedTo: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type RunPatch = Partial<
  Omit<Run, "id" | "jobId" | "trigger" | "agent" | "payload" | "attempt" | "retryOf" | "notBefore" | "createdAt">
>;

export const DEFAULT_RETRIES = 2;
export const MAX_RETRIES = 5;

export interface Settings {
  defaultAgent: AgentId;
  agents: Record<AgentId, { command: string }>;
  maxConcurrent: number;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "pi",
  agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { command: AGENT_PRESETS[id].command }])) as Settings["agents"],
  maxConcurrent: 2,
};

const SCHEMA = `
-- AUTOINCREMENT: run ids name log files and branches, so they must never be reused.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent TEXT,
  schedule TEXT,
  webhook_token TEXT,
  timeout_minutes INTEGER NOT NULL,
  check_command TEXT,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  agent TEXT NOT NULL,
  payload TEXT,
  branch TEXT,
  worktree TEXT,
  base_commit TEXT,
  head_commit TEXT,
  commits INTEGER,
  exit_code INTEGER,
  check_status TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_job ON runs(job_id, id DESC);
CREATE INDEX IF NOT EXISTS runs_by_status ON runs(status);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
`;

/** Columns added after the first release; ALTER TABLE adds them to existing databases. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["jobs", "push_branch", "INTEGER NOT NULL DEFAULT 0"],
  ["runs", "pushed_to", "TEXT"],
  ["jobs", "catch_up", "INTEGER NOT NULL DEFAULT 1"],
  ["jobs", "retries", `INTEGER NOT NULL DEFAULT ${DEFAULT_RETRIES}`],
  ["jobs", "last_fired_at", "TEXT"],
  ["runs", "attempt", "INTEGER NOT NULL DEFAULT 1"],
  ["runs", "retry_of", "INTEGER"],
  ["runs", "not_before", "TEXT"],
];

type Row = Record<string, SQLInputValue>;

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  branch: "branch",
  worktree: "worktree",
  baseCommit: "base_commit",
  headCommit: "head_commit",
  commits: "commits",
  exitCode: "exit_code",
  checkStatus: "check_status",
  pushedTo: "pushed_to",
  error: "error",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

const now = () => new Date().toISOString();

const hashToken = (secret: string) => createHash("sha256").update(secret).digest("hex");

export interface ApiToken {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function toJob(row: Row): Job {
  return {
    id: Number(row.id),
    name: String(row.name),
    repoPath: String(row.repo_path),
    baseRef: String(row.base_ref),
    prompt: String(row.prompt),
    agent: isAgentId(row.agent) ? row.agent : null,
    schedule: (row.schedule as string | null) ?? null,
    webhookToken: (row.webhook_token as string | null) ?? null,
    timeoutMinutes: Number(row.timeout_minutes),
    checkCommand: (row.check_command as string | null) ?? null,
    pushBranch: row.push_branch === 1,
    catchUp: row.catch_up === 1,
    retries: Number(row.retries),
    enabled: row.enabled === 1,
    lastFiredAt: (row.last_fired_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRun(row: Row): Run {
  const num = (v: SQLInputValue | undefined) => (v == null ? null : Number(v));
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    trigger: row.trigger as Trigger,
    status: row.status as RunStatus,
    agent: row.agent as AgentId,
    payload: row.payload as string | null,
    attempt: Number(row.attempt),
    retryOf: num(row.retry_of),
    notBefore: (row.not_before as string | null) ?? null,
    branch: row.branch as string | null,
    worktree: row.worktree as string | null,
    baseCommit: row.base_commit as string | null,
    headCommit: row.head_commit as string | null,
    commits: num(row.commits),
    exitCode: num(row.exit_code),
    checkStatus: row.check_status as Run["checkStatus"],
    pushedTo: (row.pushed_to as string | null) ?? null,
    error: row.error as string | null,
    createdAt: String(row.created_at),
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  listJobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY name COLLATE NOCASE, id").all().map((r) => toJob(r as Row));
  }

  getJob(id: number): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? toJob(row as Row) : null;
  }

  createJob(input: JobInput, webhookToken: string | null): Job {
    const ts = now();
    const result = this.db
      .prepare(
        `INSERT INTO jobs (name, repo_path, base_ref, prompt, agent, schedule, webhook_token,
           timeout_minutes, check_command, push_branch, catch_up, retries, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.repoPath,
        input.baseRef,
        input.prompt,
        input.agent,
        input.schedule,
        webhookToken,
        input.timeoutMinutes,
        input.checkCommand,
        input.pushBranch ? 1 : 0,
        input.catchUp ? 1 : 0,
        input.retries,
        input.enabled ? 1 : 0,
        ts,
        ts,
      );
    return this.getJob(Number(result.lastInsertRowid))!;
  }

  updateJob(id: number, input: JobInput, webhookToken: string | null): Job | null {
    this.db
      .prepare(
        `UPDATE jobs SET name = ?, repo_path = ?, base_ref = ?, prompt = ?, agent = ?, schedule = ?,
           webhook_token = ?, timeout_minutes = ?, check_command = ?, push_branch = ?, catch_up = ?, retries = ?,
           enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        input.repoPath,
        input.baseRef,
        input.prompt,
        input.agent,
        input.schedule,
        webhookToken,
        input.timeoutMinutes,
        input.checkCommand,
        input.pushBranch ? 1 : 0,
        input.catchUp ? 1 : 0,
        input.retries,
        input.enabled ? 1 : 0,
        now(),
        id,
      );
    return this.getJob(id);
  }

  markFired(id: number): void {
    this.db.prepare("UPDATE jobs SET last_fired_at = ? WHERE id = ?").run(now(), id);
  }

  deleteJob(id: number): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  createRun(jobId: number, trigger: Trigger, agent: AgentId, payload: string | null): Run {
    const result = this.db
      .prepare("INSERT INTO runs (job_id, trigger, status, agent, payload, created_at) VALUES (?, ?, 'queued', ?, ?, ?)")
      .run(jobId, trigger, agent, payload, now());
    return this.getRun(Number(result.lastInsertRowid))!;
  }

  /** Queues another attempt of a finished run that may start at `notBefore`. */
  createRetry(of: Run, notBefore: Date): Run {
    const result = this.db
      .prepare(
        `INSERT INTO runs (job_id, trigger, status, agent, payload, attempt, retry_of, not_before, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(of.jobId, of.trigger, of.agent, of.payload, of.attempt + 1, of.id, notBefore.toISOString(), now());
    return this.getRun(Number(result.lastInsertRowid))!;
  }

  getRun(id: number): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row as Row) : null;
  }

  listRuns(options: { jobId?: number; limit?: number } = {}): Run[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows =
      options.jobId === undefined
        ? this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit)
        : this.db.prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(options.jobId, limit);
    return rows.map((r) => toRun(r as Row));
  }

  runIdsForJob(jobId: number): number[] {
    return this.db
      .prepare("SELECT id FROM runs WHERE job_id = ?")
      .all(jobId)
      .map((row) => Number((row as { id: number }).id));
  }

  /** The latest run of every job, keyed by job id. */
  latestRuns(): Map<number, Run> {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs GROUP BY job_id)")
      .all()
      .map((r) => toRun(r as Row));
    return new Map(rows.map((run) => [run.jobId, run]));
  }

  queuedRuns(): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY id")
      .all()
      .map((r) => toRun(r as Row));
  }

  countRuns(jobId: number, statuses: readonly RunStatus[]): number {
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE job_id = ? AND status IN (${placeholders})`)
      .get(jobId, ...statuses) as { n: number };
    return Number(row.n);
  }

  updateRun(id: number, patch: RunPatch): Run {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof RunPatch, SQLInputValue][];
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${RUN_COLUMNS[key]} = ?`).join(", ");
      this.db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
    }
    return this.getRun(id)!;
  }

  /** Runs that were mid-flight when the server stopped cannot be resumed; returns them, now failed. */
  failInterruptedRuns(): Run[] {
    return this.db
      .prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running' RETURNING *")
      .all("The server stopped while this run was in progress", now())
      .map((r) => toRun(r as Row));
  }

  listTokens(): ApiToken[] {
    return this.db
      .prepare("SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY id")
      .all()
      .map((r) => {
        const row = r as Row;
        return {
          id: Number(row.id),
          name: String(row.name),
          createdAt: String(row.created_at),
          lastUsedAt: (row.last_used_at as string | null) ?? null,
        };
      });
  }

  /** Stores only the token's hash; returns the token, which is shown once. */
  createToken(name: string): { token: ApiToken; secret: string } {
    const secret = `pjt_${randomBytes(32).toString("base64url")}`;
    const result = this.db
      .prepare("INSERT INTO api_tokens (name, token_hash, created_at) VALUES (?, ?, ?)")
      .run(name, hashToken(secret), now());
    return { token: this.listTokens().find((t) => t.id === Number(result.lastInsertRowid))!, secret };
  }

  deleteToken(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes) > 0;
  }

  /** The token matching a presented secret, recording use at most once a minute. */
  authenticate(secret: string): ApiToken | null {
    const row = this.db.prepare("SELECT id, last_used_at FROM api_tokens WHERE token_hash = ?").get(hashToken(secret)) as
      | { id: number; last_used_at: string | null }
      | undefined;
    if (!row) return null;
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) {
      this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
    }
    return this.listTokens().find((t) => t.id === Number(row.id)) ?? null;
  }

  getSettings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    const saved = JSON.parse(row.value) as Partial<Settings>;
    return {
      defaultAgent: isAgentId(saved.defaultAgent) ? saved.defaultAgent : DEFAULT_SETTINGS.defaultAgent,
      agents: Object.fromEntries(
        AGENT_IDS.map((id) => [id, { command: saved.agents?.[id]?.command ?? DEFAULT_SETTINGS.agents[id].command }]),
      ) as Settings["agents"],
      maxConcurrent: saved.maxConcurrent ?? DEFAULT_SETTINGS.maxConcurrent,
    };
  }

  saveSettings(settings: Settings): Settings {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings));
    return this.getSettings();
  }
}
