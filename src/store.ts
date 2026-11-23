import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AGENT_IDS, AGENT_PRESETS, isAgentId, type AgentId } from "./agents.ts";

export type Trigger = "manual" | "schedule" | "webhook" | "watch";
/** A change run may commit to a branch; an ask run only answers, and its checkout is discarded. */
export type RunMode = "change" | "ask";
export type RunStatus = "awaiting_approval" | "queued" | "running" | "succeeded" | "failed" | "canceled" | "timed_out";
/** Runs that haven't finished: one waiting for approval counts, so it holds back the schedule too. */
export const ACTIVE_STATUSES: readonly RunStatus[] = ["awaiting_approval", "queued", "running"];
/** Runs that haven't started, which the per-job queue limit counts. */
export const WAITING_STATUSES: readonly RunStatus[] = ["awaiting_approval", "queued"];

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
  /**
   * Shell command run in the repository on each schedule fire instead of an agent: every JSON
   * line it prints with an `id` not seen before starts one run with that line as its payload.
   */
  watchCommand: string | null;
  /** Runs started by the schedule, webhook or watch wait for approval; manual runs never do. */
  approveRuns: boolean;
  enabled: boolean;
}

export interface Job extends JobInput {
  id: number;
  /** Null means the webhook trigger is off. */
  webhookToken: string | null;
  /** When the schedule last fired (or a missed fire was handled). */
  lastFiredAt: string | null;
  /** When the watch command last finished, and what went wrong if it did. */
  watchCheckedAt: string | null;
  watchError: string | null;
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
  /** The finished run this one follows up on: it starts from that run's result with new instructions. */
  followUpOf: number | null;
  /** A follow-up's instructions, which take the place of the job's. */
  instructions: string | null;
  mode: RunMode;
  /** The first run of this one's item: a triggered run, with its retries and follow-ups. */
  itemId: number;
  /** The agent session the run used, which its item's later runs resume; null for agents without sessions. */
  sessionId: string | null;
  /** What the agent printed (its final report), saved when the run finishes; "" when it printed nothing. */
  summary: string | null;
  /** When the owner marked the item replied to, or closed it; null otherwise. */
  repliedAt: string | null;
  closedAt: string | null;
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
  Omit<Run, "id" | "jobId" | "trigger" | "agent" | "payload" | "attempt" | "retryOf" | "notBefore" | "followUpOf" | "instructions" | "mode" | "itemId" | "createdAt">
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
-- Items a job's watch command printed, so each starts one run.
CREATE TABLE IF NOT EXISTS watch_items (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  run_id INTEGER,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (job_id, item_id)
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
  ["jobs", "watch_command", "TEXT"],
  ["jobs", "approve_runs", "INTEGER NOT NULL DEFAULT 0"],
  ["jobs", "watch_checked_at", "TEXT"],
  ["jobs", "watch_error", "TEXT"],
  ["runs", "follow_up_of", "INTEGER"],
  ["runs", "instructions", "TEXT"],
  ["runs", "summary", "TEXT"],
  ["runs", "replied_at", "TEXT"],
  ["runs", "closed_at", "TEXT"],
  ["runs", "mode", "TEXT NOT NULL DEFAULT 'change'"],
  ["runs", "item_id", "INTEGER"],
  ["runs", "session_id", "TEXT"],
];

type Row = Record<string, SQLInputValue>;

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  summary: "summary",
  sessionId: "session_id",
  repliedAt: "replied_at",
  closedAt: "closed_at",
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

/**
 * An owner-chosen token (a password, say) may be anything an HTTP header can carry intact: 1 to 200
 * printable ASCII characters, with spaces allowed inside but not at the ends, where headers drop them.
 */
export const TOKEN_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/;
export const TOKEN_RULE = "Use 1 to 200 letters, digits, symbols or spaces, not starting or ending with a space";

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
    watchCommand: (row.watch_command as string | null) ?? null,
    approveRuns: row.approve_runs === 1,
    enabled: row.enabled === 1,
    lastFiredAt: (row.last_fired_at as string | null) ?? null,
    watchCheckedAt: (row.watch_checked_at as string | null) ?? null,
    watchError: (row.watch_error as string | null) ?? null,
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
    followUpOf: num(row.follow_up_of),
    instructions: (row.instructions as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    mode: row.mode === "ask" ? "ask" : "change",
    itemId: Number(row.item_id ?? row.id),
    sessionId: (row.session_id as string | null) ?? null,
    repliedAt: (row.replied_at as string | null) ?? null,
    closedAt: (row.closed_at as string | null) ?? null,
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
    this.transaction(() => this.backfillItems());
    // After the columns exist: databases from before items get item_id from ALTER TABLE above.
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_by_item ON runs(item_id, id)");
  }

  /** Gives runs from before items were stored the item of the run they retry or follow up on. */
  private backfillItems(): void {
    const rows = this.db
      .prepare("SELECT id, follow_up_of, retry_of, item_id FROM runs ORDER BY id")
      .all() as { id: number; follow_up_of: number | null; retry_of: number | null; item_id: number | null }[];
    const items = new Map<number, number>();
    const update = this.db.prepare("UPDATE runs SET item_id = ? WHERE id = ?");
    for (const row of rows) {
      const parent = row.follow_up_of ?? row.retry_of;
      const item = row.item_id ?? (parent !== null ? (items.get(parent) ?? parent) : row.id);
      items.set(row.id, item);
      if (row.item_id === null) update.run(item, row.id);
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
           timeout_minutes, check_command, push_branch, catch_up, retries, watch_command, approve_runs, enabled,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.watchCommand,
        input.approveRuns ? 1 : 0,
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
           watch_command = ?, approve_runs = ?, enabled = ?, updated_at = ?
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
        input.watchCommand,
        input.approveRuns ? 1 : 0,
        input.enabled ? 1 : 0,
        now(),
        id,
      );
    return this.getJob(id);
  }

  markFired(id: number): void {
    this.db.prepare("UPDATE jobs SET last_fired_at = ? WHERE id = ?").run(now(), id);
  }

  /** Runs `fn` in one SQLite transaction: all of its writes happen, or none. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setWatchResult(id: number, error: string | null): void {
    this.db.prepare("UPDATE jobs SET watch_checked_at = ?, watch_error = ? WHERE id = ?").run(now(), error, id);
  }

  /** Which of `itemIds` the job's watch has already seen. */
  seenItems(jobId: number, itemIds: string[]): Set<string> {
    const seen = new Set<string>();
    const query = this.db.prepare("SELECT 1 FROM watch_items WHERE job_id = ? AND item_id = ?");
    for (const itemId of itemIds) if (query.get(jobId, itemId)) seen.add(itemId);
    return seen;
  }

  recordItem(jobId: number, itemId: string, runId: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO watch_items (job_id, item_id, run_id, seen_at) VALUES (?, ?, ?, ?)")
      .run(jobId, itemId, runId, now());
  }

  deleteJob(id: number): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  createRun(
    jobId: number,
    trigger: Trigger,
    agent: AgentId,
    payload: string | null,
    status: "queued" | "awaiting_approval" = "queued",
  ): Run {
    const result = this.db
      .prepare("INSERT INTO runs (job_id, trigger, status, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(jobId, trigger, status, agent, payload, now());
    const id = Number(result.lastInsertRowid);
    this.db.prepare("UPDATE runs SET item_id = id WHERE id = ?").run(id);
    return this.getRun(id)!;
  }

  /** Queues a run that continues `of` (a finished run) with new instructions, keeping its payload and item. */
  createFollowUp(of: Run, agent: AgentId, instructions: string, mode: RunMode = "change"): Run {
    const result = this.db
      .prepare(
        `INSERT INTO runs (job_id, trigger, status, agent, payload, follow_up_of, instructions, mode, item_id, created_at)
         VALUES (?, 'manual', 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(of.jobId, agent, of.payload, of.id, instructions, mode, of.itemId, now());
    return this.getRun(Number(result.lastInsertRowid))!;
  }

  /** Queues another attempt of a finished run that may start at `notBefore`. */
  createRetry(of: Run, notBefore: Date): Run {
    const result = this.db
      .prepare(
        `INSERT INTO runs (job_id, trigger, status, agent, payload, attempt, retry_of, not_before, follow_up_of, instructions,
           mode, item_id, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        of.jobId,
        of.trigger,
        of.agent,
        of.payload,
        of.attempt + 1,
        of.id,
        notBefore.toISOString(),
        of.followUpOf,
        of.instructions,
        of.mode,
        of.itemId,
        now(),
      );
    return this.getRun(Number(result.lastInsertRowid))!;
  }

  /** Runs that kept their worktree at this path. */
  runsWithWorktree(worktree: string): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE worktree = ?")
      .all(worktree)
      .map((r) => toRun(r as Row));
  }

  /** Every run of an item, oldest first. */
  itemRuns(itemId: number): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE item_id = ? ORDER BY id")
      .all(itemId)
      .map((r) => toRun(r as Row));
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

  /** Finished runs from before summaries were saved. */
  runsWithoutSummary(): number[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT id FROM runs WHERE summary IS NULL AND status NOT IN (${placeholders})`)
      .all(...ACTIVE_STATUSES)
      .map((row) => Number((row as { id: number }).id));
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

  /** Stores only the token's hash; returns the token (generated unless given), which is shown once. */
  createToken(name: string, secret = `pjt_${randomBytes(32).toString("base64url")}`): { token: ApiToken; secret: string } {
    const result = this.db
      .prepare("INSERT INTO api_tokens (name, token_hash, created_at) VALUES (?, ?, ?)")
      .run(name, hashToken(secret), now());
    return { token: this.listTokens().find((t) => t.id === Number(result.lastInsertRowid))!, secret };
  }

  tokenInUse(secret: string): boolean {
    return this.db.prepare("SELECT 1 FROM api_tokens WHERE token_hash = ?").get(hashToken(secret)) !== undefined;
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
