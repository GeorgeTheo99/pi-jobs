import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** The remote runs start from and push result branches to. */
export const REMOTE = "origin";
export const NETWORK_TIMEOUT_MS = 120_000;

/** One file a run changed. */
export interface ChangedFile {
  path: string;
  /** The path before a rename or copy. */
  oldPath: string | null;
  /** git's status letter: A added, M modified, D deleted, R renamed, C copied, T type changed. */
  status: string;
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
}

/** What a run changed, from `from` to its head commit. */
export interface RunChanges {
  from: string;
  to: string;
  files: ChangedFile[];
  patch: string;
  /** The patch was cut at MAX_PATCH bytes. */
  truncated: boolean;
}

/** The branch a base ref names on origin: "main" for both "main" and "origin/main". */
export function baseBranch(baseRef: string): string {
  return baseRef.startsWith(`${REMOTE}/`) ? baseRef.slice(REMOTE.length + 1) : baseRef;
}

/** Whether a base ref is a branch that can be fetched from origin (not a tag, commit, HEAD or revision expression). */
export async function isFetchableBranch(repo: string, ref: string): Promise<boolean> {
  const branch = baseBranch(ref);
  if (ref === "HEAD" || ref.startsWith("refs/") || /^[0-9a-f]{7,40}$/i.test(ref)) return false;
  if (!(await git(repo, ["remote"])).split("\n").includes(REMOTE)) return false;
  if (await resolvesToCommit(repo, `refs/tags/${ref}`)) return false;
  try {
    // Rejects revision syntax (~ ^ : @{ ..) and anything else that is not a branch name.
    await git(repo, ["check-ref-format", "--branch", branch]);
    return !branch.startsWith("-");
  } catch {
    return false;
  }
}

/** Joins `git diff --name-status -z` and `--numstat -z` output (same order) into one list. */
export function parseChangedFiles(names: string, counts: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const nameParts = names.split("\0");
  for (let i = 0; i < nameParts.length - 1; ) {
    const status = nameParts[i++]!;
    if (!status) continue;
    const letter = status[0]!;
    if (letter === "R" || letter === "C") {
      const oldPath = nameParts[i++]!;
      files.push({ path: nameParts[i++]!, oldPath, status: letter, additions: null, deletions: null });
    } else {
      files.push({ path: nameParts[i++]!, oldPath: null, status: letter, additions: null, deletions: null });
    }
  }
  // numstat -z: "added\tdeleted\tpath\0", or for renames "added\tdeleted\t\0old\0new\0".
  const countParts = counts.split("\0");
  let index = 0;
  for (let i = 0; i < countParts.length && index < files.length; ) {
    const head = countParts[i++]!;
    if (!head) continue;
    const [added, deleted, path] = head.split("\t");
    if (path === "") i += 2;
    const file = files[index++]!;
    file.additions = added === "-" ? null : Number(added);
    file.deletions = deleted === "-" ? null : Number(deleted);
  }
  return files;
}

/** Like git(), but keeps the output's whitespace (patches end with a newline) and takes a buffer size. */
export async function gitRaw(cwd: string, args: string[], maxBuffer: number): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout;
}

export async function git(cwd: string, args: string[], timeout = 0): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout,
      // Never wait on a credential prompt; the server has no terminal.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function resolvesToCommit(dir: string, ref: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
