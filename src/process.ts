import { execFile, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Session-scoped variables that leak in when the server is started from inside an agent session. */
export const SESSION_ENV = [
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_CODING_AGENT",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
];

/** The environment without variables from an enclosing agent session. */
export function withoutSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SESSION_ENV.includes(key)));
}

export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * SIGKILLs every process left over from a run: those that inherited its PI_JOBS_RUN_TOKEN (macOS
 * `ps -E`; platform binaries hide their environment) and those whose working directory is inside
 * the run's worktree (unless it is null: a command job's directory is shared).
 */
export async function killRunProcesses(token: string, worktree: string | null): Promise<void> {
  const pids = new Set<number>();
  const marker = `PI_JOBS_RUN_TOKEN=${token}`;
  for (const line of (await commandOutput("ps", ["-AEww", "-o", "pid=,command="])).split("\n")) {
    if (line.includes(marker)) pids.add(Number.parseInt(line, 10));
  }
  // lsof -F prints "p<pid>" then "n<cwd>" for each process.
  let pid = 0;
  for (const line of worktree === null ? [] : (await commandOutput("lsof", ["-nP", "-d", "cwd", "-Fpn"])).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && (line.slice(1) === worktree || line.startsWith(`n${worktree}/`))) pids.add(pid);
  }
  for (const target of pids) {
    if (!target || target === process.pid) continue;
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Stdout of a listing command, even when it exits non-zero (lsof does when some processes are unreadable). */
async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    return (await execFileP(command, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) console.error(`${command} failed while cleaning up after a run:`, error);
    return stdout ?? "";
  }
}


/** A process pi-jobs started in its own group, and the timer that escalates its stop to SIGKILL. */
export interface ProcessHandle {
  child: ChildProcess | null;
  killTimer: NodeJS.Timeout | null;
}

/** Asks a process group to stop, escalating to SIGKILL after `graceMs`; the escalation is cleared once it exits, so a reused PID is never hit. */
export function terminate(handle: ProcessHandle, graceMs: number): void {
  const pid = handle.child?.pid;
  signalGroup(pid, "SIGTERM");
  handle.killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), graceMs);
  handle.killTimer.unref();
}

export interface GroupOptions {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
  /** PI_JOBS_RUN_TOKEN in `env`: what marks the processes it leaves behind. */
  token: string;
  /** Called with the child once it is started, e.g. to read its pipes. */
  onSpawn?: (child: ChildProcess) => void;
  /** Called once when it has exited, before leftovers are reaped (to close a log file, say). */
  onExit?: () => void;
  /** Also reap processes working inside `cwd` (default); off for a shared directory, such as a command job's. */
  sweepCwd?: boolean;
}

/**
 * Runs a command in its own process group, so it and everything it starts can be signalled together.
 * Resolves with its exit code (null for a signal) once it has exited and the processes it left behind
 * (its group, anything with its token, anything working inside `cwd`) are killed.
 */
export function runInGroup(handle: ProcessHandle, options: GroupOptions): Promise<number | null> {
  const { argv, cwd, env, stdio, token } = options;
  let child: ChildProcess;
  try {
    child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio, env });
  } catch (error) {
    options.onExit?.();
    return Promise.reject(new Error(`Could not start ${argv[0]}: ${(error as Error).message}`));
  }
  handle.child = child;
  options.onSpawn?.(child);
  // lsof reports resolved paths (/private/tmp, not /tmp); resolve now, while the directory exists.
  const realCwd = realpathSync(cwd);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      options.onExit?.();
      handle.child = null;
      if (handle.killTimer) clearTimeout(handle.killTimer);
      handle.killTimer = null;
      done();
    };
    // A failed spawn emits "error" (and, on some versions, "close" as well); later errors are followed by "close".
    child.on("error", (error) => {
      if (child.pid === undefined) settle(() => reject(new Error(`Could not start ${argv[0]}: ${error.message}`)));
    });
    child.once("close", (code) =>
      settle(() => {
        // Reap anything left running: the group, plus processes started in other sessions (Pi's bash tool detaches each command).
        signalGroup(child.pid, "SIGKILL");
        void killRunProcesses(token, options.sweepCwd === false ? null : realCwd).finally(() => resolve(code));
      }),
    );
  });
}
