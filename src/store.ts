import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AGENT_ID_PATTERN, AGENT_PRESETS, BUILTIN_AGENT_IDS, agentCommand, type AgentId } from "./agents.ts";

export type Trigger = "manual" | "schedule" | "webhook" | "watch";
/**
 * A change run may commit to a branch; an ask run only answers, and its checkout is discarded. A
 * release: a "release" run has the agent release the item's result by the job's release instructions,
 * a "ship" run runs the job's release script (shipCommand, no agent) on it. A command run runs a
 * command job's shell command in its directory: no agent, worktree or branch.
 */
export type RunMode = "change" | "ask" | "ship" | "release" | "command";
/** Runs that release an item, by its agent or its release script. */
export const RELEASE_MODES: readonly RunMode[] = ["ship", "release"];
/**
 * A release run's stage, for jobs that promote: "staging" releases the item to staging (the job's
 * release instructions or script), "production" promotes the staged commit (its promote
 * instructions). Null for a release that goes all the way, and for every other run.
 */
export type ReleaseStage = "staging" | "production";
export type RunStatus = "awaiting_approval" | "queued" | "running" | "succeeded" | "failed" | "canceled" | "timed_out";
/** Runs that haven't finished: one waiting for approval counts, so it holds back the schedule too. */
export const ACTIVE_STATUSES: readonly RunStatus[] = ["awaiting_approval", "queued", "running"];
/** Runs that haven't started, which the per-job queue limit counts. */
export const WAITING_STATUSES: readonly RunStatus[] = ["awaiting_approval", "queued"];

/** An agent job runs a coding agent in a worktree; a command job runs a shell command in a directory. */
export type JobKind = "agent" | "command";

export interface JobInput {
  name: string;
  kind: JobKind;
  /** The git repository an agent job works on, or the directory a command job runs in. */
  repoPath: string;
  baseRef: string;
  /** An agent job's instructions; "" for a command job. */
  prompt: string;
  /** A command job's shell command (run with /bin/sh -c); null for an agent job. */
  command: string | null;
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
  /**
   * The release script (merge, release, deploy: whatever the repository's own script does), run on
   * an item's result when the owner releases it, or by autoRelease. Exclusive with releaseInstructions.
   */
  shipCommand: string | null;
  /**
   * Instructions for the agent to release an item's result (merge, push, deploy, publish), in place of
   * a ship command. The agent may push in that run only; the owner starts it, or autoRelease does.
   */
  releaseInstructions: string | null;
  /**
   * Shell command run in the repository after a release exits 0 (a health check, say); it must exit 0
   * too, or the release fails.
   */
  verifyCommand: string | null;
  /**
   * Instructions for the agent to promote an item's staged commit to production. When set, releases
   * stop at staging and the owner promotes each item afterwards; null for one-stage releases.
   */
  promoteInstructions: string | null;
  /** Shell command run after a promotion exits 0 (a production health check, say); it must exit 0 too. */
  promoteVerifyCommand: string | null;
  /** Ship an item as soon as a run of it succeeds with changes, without waiting for the owner. */
  autoRelease: boolean;
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
  /** A release run's stage when its job promotes; null otherwise. */
  stage: ReleaseStage | null;
  /** The first run of this one's item: a triggered run, with its retries and follow-ups. */
  itemId: number;
  /** The agent session the run used, which its item's later runs resume; null for agents without sessions. */
  sessionId: string | null;
  /** What the agent printed (its final report), saved when the run finishes; "" when it printed nothing. */
  summary: string | null;
  /** Who started or approved it (an API token's name, or "autoRelease"); null when not recorded. */
  requestedBy: string | null;
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
  /** What a release left for later, by its report's or verify command's "Still to ship:" lines; null when nothing. */
  stillToShip: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type RunPatch = Partial<
  Omit<Run, "id" | "jobId" | "trigger" | "payload" | "attempt" | "retryOf" | "notBefore" | "followUpOf" | "instructions" | "stage" | "itemId" | "createdAt">
>;

export const DEFAULT_RETRIES = 2;
export const MAX_RETRIES = 5;

/** A conversation with an agent about managing pi-jobs, optionally about one job or item. */
export interface Chat {
  id: number;
  title: string;
  /** The job or item (any of its runs) the chat started from, for context; null for a general chat. */
  jobId: number | null;
  runId: number | null;
  agent: AgentId;
  /** The agent session every turn continues; null for agents without sessions. */
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatTurnStatus = "running" | "succeeded" | "failed" | "canceled";
export type ChatActionStatus = "proposed" | "applied" | "failed" | "dismissed" | "invalid";

/** A change the chat's agent proposed; it happens only when the owner applies it. */
export interface ChatAction {
  /** The action's type and arguments, as the agent proposed them. */
  type: string;
  args: Record<string, unknown>;
  /** What it does, in a sentence. */
  title: string;
  /** Exact before/after values for the fields it changes, shown on its card. */
  changes: { field: string; before: unknown; after: unknown }[];
  /** Shown in full and applied one at a time, never with Apply all. */
  risky: boolean;
  /** What the target looked like when proposed; applying refuses if it has changed since. */
  basis: string | null;
  status: ChatActionStatus;
  /** What applying it did, without secrets. */
  result: string | null;
  error: string | null;
}

/** One message from the owner and the agent's reply, with the actions it proposed. */
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

export type ChatTurnPatch = Partial<Pick<ChatTurn, "reply" | "actions" | "status" | "error" | "exitCode" | "startedAt" | "finishedAt">>;

export interface Settings {
  defaultAgent: AgentId;
  /** The built-in agents (pi, claude, codex) first, then any added in Settings, by id. */
  agents: Record<AgentId, { command: string }>;
  /** Runs at the same time, 1 to MAX_CONCURRENT. */
  maxConcurrent: number;
  /** Shell command run on events that need the owner (PI_JOBS_EVENT, _TITLE, _MESSAGE, _URL in its environment); null for none. */
  notifyCommand: string | null;
  /** Where the owner opens the UI (behind a proxy, say), for links in notifications; null to use the local address. */
  publicUrl: string | null;
}

export const MAX_CONCURRENT = 10;

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "pi",
  agents: Object.fromEntries(BUILTIN_AGENT_IDS.map((id) => [id, { command: AGENT_PRESETS[id].command }])),
  maxConcurrent: 2,
  notifyCommand: null,
  publicUrl: null,
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
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  agent TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- AUTOINCREMENT: turn ids name log files.
CREATE TABLE IF NOT EXISTS chat_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  reply TEXT,
  actions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_turns_by_chat ON chat_turns(chat_id, id);
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
  ["jobs", "ship_command", "TEXT"],
  ["jobs", "release_instructions", "TEXT"],
  ["jobs", "auto_release", "INTEGER NOT NULL DEFAULT 0"],
  ["jobs", "verify_command", "TEXT"],
  ["runs", "requested_by", "TEXT"],
  ["jobs", "kind", "TEXT NOT NULL DEFAULT 'agent'"],
  ["jobs", "command", "TEXT"],
  ["jobs", "promote_instructions", "TEXT"],
  ["jobs", "promote_verify_command", "TEXT"],
  ["runs", "stage", "TEXT"],
  ["runs", "still_to_ship", "TEXT"],
];

type Row = Record<string, SQLInputValue>;

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  mode: "mode",
  agent: "agent",
  requestedBy: "requested_by",
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
  stillToShip: "still_to_ship",
  error: "error",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

const now = () => new Date().toISOString();

/** The error of a run a server stop cut off. */
export const INTERRUPTED = "The server stopped while this run was in progress";

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
    kind: row.kind === "command" ? "command" : "agent",
    repoPath: String(row.repo_path),
    baseRef: String(row.base_ref),
    prompt: String(row.prompt),
    command: (row.command as string | null) ?? null,
    agent: typeof row.agent === "string" && row.agent ? row.agent : null,
    schedule: (row.schedule as string | null) ?? null,
    webhookToken: (row.webhook_token as string | null) ?? null,
    timeoutMinutes: Number(row.timeout_minutes),
    checkCommand: (row.check_command as string | null) ?? null,
    pushBranch: row.push_branch === 1,
    catchUp: row.catch_up === 1,
    retries: Number(row.retries),
    watchCommand: (row.watch_command as string | null) ?? null,
    shipCommand: (row.ship_command as string | null) ?? null,
    releaseInstructions: (row.release_instructions as string | null) ?? null,
    autoRelease: row.auto_release === 1,
    verifyCommand: (row.verify_command as string | null) ?? null,
    promoteInstructions: (row.promote_instructions as string | null) ?? null,
    promoteVerifyCommand: (row.promote_verify_command as string | null) ?? null,
    approveRuns: row.approve_runs === 1,
    enabled: row.enabled === 1,
    lastFiredAt: (row.last_fired_at as string | null) ?? null,
    watchCheckedAt: (row.watch_checked_at as string | null) ?? null,
    watchError: (row.watch_error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChat(row: Row): Chat {
  return {
    id: Number(row.id),
    title: String(row.title),
    jobId: row.job_id == null ? null : Number(row.job_id),
    runId: row.run_id == null ? null : Number(row.run_id),
    agent: row.agent as AgentId,
    sessionId: (row.session_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toTurn(row: Row): ChatTurn {
  return {
    id: Number(row.id),
    chatId: Number(row.chat_id),
    message: String(row.message),
    reply: (row.reply as string | null) ?? null,
    actions: JSON.parse(String(row.actions ?? "[]")) as ChatAction[],
    status: row.status as ChatTurnStatus,
    error: (row.error as string | null) ?? null,
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
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
    mode: row.mode === "ask" || row.mode === "ship" || row.mode === "release" || row.mode === "command" ? row.mode : "change",
    stage: row.stage === "staging" || row.stage === "production" ? row.stage : null,
    itemId: Number(row.item_id ?? row.id),
    sessionId: (row.session_id as string | null) ?? null,
    requestedBy: (row.requested_by as string | null) ?? null,
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
    stillToShip: (row.still_to_ship as string | null) ?? null,
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

  createChat(input: { title: string; jobId: number | null; runId: number | null; agent: AgentId; sessionId: string | null }): Chat {
    const ts = now();
    const result = this.db
      .prepare("INSERT INTO chats (title, job_id, run_id, agent, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.title, input.jobId, input.runId, input.agent, input.sessionId, ts, ts);
    return this.getChat(Number(result.lastInsertRowid))!;
  }

  getChat(id: number): Chat | null {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
    return row ? toChat(row as Row) : null;
  }

  /** Newest activity first. */
  listChats(limit = 50): Chat[] {
    return this.db
      .prepare("SELECT * FROM chats ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map((r) => toChat(r as Row));
  }

  touchChat(id: number): void {
    this.db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  deleteChat(id: number): void {
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  }

  createTurn(chatId: number, message: string): ChatTurn {
    const ts = now();
    const result = this.db
      .prepare("INSERT INTO chat_turns (chat_id, message, status, created_at, started_at) VALUES (?, ?, 'running', ?, ?)")
      .run(chatId, message, ts, ts);
    this.touchChat(chatId);
    return this.getTurn(Number(result.lastInsertRowid))!;
  }

  getTurn(id: number): ChatTurn | null {
    const row = this.db.prepare("SELECT * FROM chat_turns WHERE id = ?").get(id);
    return row ? toTurn(row as Row) : null;
  }

  /** Oldest first. */
  chatTurns(chatId: number): ChatTurn[] {
    return this.db
      .prepare("SELECT * FROM chat_turns WHERE chat_id = ? ORDER BY id")
      .all(chatId)
      .map((r) => toTurn(r as Row));
  }

  updateTurn(id: number, patch: ChatTurnPatch): ChatTurn {
    const columns: Record<keyof ChatTurnPatch, string> = {
      reply: "reply",
      actions: "actions",
      status: "status",
      error: "error",
      exitCode: "exit_code",
      startedAt: "started_at",
      finishedAt: "finished_at",
    };
    const entries = Object.entries(patch) as [keyof ChatTurnPatch, unknown][];
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${columns[key]} = ?`).join(", ");
      const values = entries.map(([key, value]) => (key === "actions" ? JSON.stringify(value) : (value as SQLInputValue)));
      this.db.prepare(`UPDATE chat_turns SET ${sets} WHERE id = ?`).run(...values, id);
    }
    return this.getTurn(id)!;
  }

  /** Turns cut off by a server stop can't be resumed; returns them, now failed. */
  failInterruptedTurns(): ChatTurn[] {
    return this.db
      .prepare("UPDATE chat_turns SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running' RETURNING *")
      .all("The server stopped while the agent was replying", now())
      .map((r) => toTurn(r as Row));
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
        `INSERT INTO jobs (name, kind, command, repo_path, base_ref, prompt, agent, schedule, webhook_token,
           timeout_minutes, check_command, push_branch, catch_up, retries, watch_command, approve_runs, ship_command,
           release_instructions, verify_command, promote_instructions, promote_verify_command, auto_release, enabled,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.kind,
        input.command,
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
        input.shipCommand,
        input.releaseInstructions,
        input.verifyCommand,
        input.promoteInstructions,
        input.promoteVerifyCommand,
        input.autoRelease ? 1 : 0,
        input.enabled ? 1 : 0,
        ts,
        ts,
      );
    return this.getJob(Number(result.lastInsertRowid))!;
  }

  updateJob(id: number, input: JobInput, webhookToken: string | null): Job | null {
    this.db
      .prepare(
        `UPDATE jobs SET name = ?, kind = ?, command = ?, repo_path = ?, base_ref = ?, prompt = ?, agent = ?, schedule = ?,
           webhook_token = ?, timeout_minutes = ?, check_command = ?, push_branch = ?, catch_up = ?, retries = ?,
           watch_command = ?, approve_runs = ?, ship_command = ?, release_instructions = ?, verify_command = ?,
           promote_instructions = ?, promote_verify_command = ?, auto_release = ?, enabled = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        input.kind,
        input.command,
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
        input.shipCommand,
        input.releaseInstructions,
        input.verifyCommand,
        input.promoteInstructions,
        input.promoteVerifyCommand,
        input.autoRelease ? 1 : 0,
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
    mode: "change" | "command" = "change",
  ): Run {
    const result = this.db
      .prepare("INSERT INTO runs (job_id, trigger, status, agent, payload, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(jobId, trigger, status, agent, payload, mode, now());
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

  /**
   * Queues a ship run on `of`'s item: the job's ship command (mode "ship") or release or promote
   * instructions (mode "release"), recorded as the run's instructions. A ship command's run carries the
   * item's agent session on, so the agent's next follow-up continues that conversation; a release run
   * picks its session when it starts, like a follow-up.
   */
  createRelease(of: Run, agent: AgentId, instructions: string, mode: "ship" | "release" = "ship", stage: ReleaseStage | null = null): Run {
    const result = this.db
      .prepare(
        `INSERT INTO runs (job_id, trigger, status, agent, payload, follow_up_of, instructions, mode, stage, item_id, session_id, created_at)
         VALUES (?, 'manual', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(of.jobId, agent, of.payload, of.id, instructions, mode, stage, of.itemId, mode === "ship" ? of.sessionId : null, now());
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

  /** Items' ids (their first runs'), newest activity first. */
  itemIds(options: { jobId?: number; limit?: number } = {}): number[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows =
      options.jobId === undefined
        ? this.db.prepare("SELECT item_id FROM runs GROUP BY item_id ORDER BY MAX(id) DESC LIMIT ?").all(limit)
        : this.db.prepare("SELECT item_id FROM runs WHERE job_id = ? GROUP BY item_id ORDER BY MAX(id) DESC LIMIT ?").all(options.jobId, limit);
    return rows.map((row) => Number((row as { item_id: number }).item_id));
  }

  /** The runs of these items, oldest first. */
  runsOfItems(itemIds: number[]): Run[] {
    if (itemIds.length === 0) return [];
    return this.db
      .prepare(`SELECT * FROM runs WHERE item_id IN (${itemIds.map(() => "?").join(", ")}) ORDER BY id`)
      .all(...itemIds)
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

  /** Staging releases of the job's other items that started after run `afterId`: each replaced what was on staging. */
  laterStagings(jobId: number, itemId: number, afterId: number): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE job_id = ? AND stage = 'staging' AND item_id != ? AND id > ? AND started_at IS NOT NULL ORDER BY id")
      .all(jobId, itemId, afterId)
      .map((r) => toRun(r as Row));
  }

  /** Releases a server stop cut off since `since`: they may have gone out before it. */
  interruptedReleases(since: string): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE mode = 'release' AND status = 'failed' AND error = ? AND finished_at >= ? ORDER BY id")
      .all(INTERRUPTED, since)
      .map((r) => toRun(r as Row));
  }

  /** Runs that were mid-flight when the server stopped cannot be resumed; returns them, now failed. */
  failInterruptedRuns(): Run[] {
    return this.db
      .prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running' RETURNING *")
      .all(INTERRUPTED, now())
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
    const agents: Settings["agents"] = {};
    for (const id of BUILTIN_AGENT_IDS) agents[id] = { command: saved.agents?.[id]?.command ?? DEFAULT_SETTINGS.agents[id]!.command };
    for (const [id, entry] of Object.entries(saved.agents ?? {})) {
      if (!Object.hasOwn(agents, id) && AGENT_ID_PATTERN.test(id) && typeof entry?.command === "string") agents[id] = { command: entry.command };
    }
    return {
      defaultAgent: typeof saved.defaultAgent === "string" && agentCommand(agents, saved.defaultAgent) !== null ? saved.defaultAgent : DEFAULT_SETTINGS.defaultAgent,
      agents,
      maxConcurrent: saved.maxConcurrent ?? DEFAULT_SETTINGS.maxConcurrent,
      notifyCommand: saved.notifyCommand ?? null,
      publicUrl: saved.publicUrl ?? null,
    };
  }

  saveSettings(settings: Settings): Settings {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings));
    return this.getSettings();
  }
}
