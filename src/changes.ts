import { ACTIVE_STATUSES, type Job, type Run, type Store } from "./store.ts";
import { REMOTE, baseBranch, git, gitRaw, parseChangedFiles, resolvesToCommit, type RunChanges } from "./git.ts";

/** The largest patch the run page shows. */
const MAX_PATCH = 1024 * 1024;
/** How long a base branch's tip is reused when checking which runs were merged. */
const BASE_TIP_TTL_MS = 5_000;

/** What runs changed, and whether their commits are in their job's base branch, read from git with brief caching. */
export class RepoState {
  private readonly mergedCache = new Map<string, boolean>();
  private readonly baseTips = new Map<string, { tip: string | null; at: number }>();

  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * The files and patch a run changed: its own commits by default, or with `sinceBase`, everything
   * since the job's base (a follow-up's earlier runs included). Null when the run left no commits.
   */
  async changes(job: Job, run: Run, sinceBase = false): Promise<RunChanges | null> {
    if (!run.headCommit || !run.baseCommit || (run.commits ?? 0) === 0) return null;
    if (!(await resolvesToCommit(job.repoPath, run.headCommit))) return null;
    let from = run.baseCommit;
    if (sinceBase) {
      const tip = await this.baseTip(job);
      if (tip) from = await git(job.repoPath, ["merge-base", tip, run.headCommit]).catch(() => run.baseCommit!);
    }
    const range = [from, run.headCommit];
    const [names, counts] = await Promise.all([
      git(job.repoPath, ["diff", "--name-status", "-M", "-z", ...range]),
      git(job.repoPath, ["diff", "--numstat", "-M", "-z", ...range]),
    ]);
    const files = parseChangedFiles(names, counts);
    let patch = "";
    let truncated = false;
    try {
      patch = await gitRaw(job.repoPath, ["diff", "-M", "--no-color", "--no-ext-diff", ...range], MAX_PATCH * 4);
    } catch {
      truncated = true;
    }
    if (Buffer.byteLength(patch) > MAX_PATCH) {
      patch = Buffer.from(patch).subarray(0, MAX_PATCH).toString("utf8");
      truncated = true;
    }
    return { from, to: run.headCommit, files, patch, truncated };
  }

  /**
   * Which of these runs' commits are already in their job's base branch (merged, so done), by run
   * id. Runs without commits are left out. Uses the last fetched tip of origin/<base> where there is
   * one, otherwise the local ref; never fetches.
   */
  async mergedRuns(runs: Run[]): Promise<Set<number>> {
    const merged = new Set<number>();
    for (const run of runs) {
      if (!run.headCommit || (run.commits ?? 0) === 0 || ACTIVE_STATUSES.includes(run.status)) continue;
      const job = this.store.getJob(run.jobId);
      if (!job) continue;
      const tip = await this.baseTip(job);
      if (!tip) continue;
      const key = `${job.repoPath}\0${run.headCommit}\0${tip}`;
      let isMerged = this.mergedCache.get(key);
      if (isMerged === undefined) {
        isMerged = await git(job.repoPath, ["merge-base", "--is-ancestor", run.headCommit, tip]).then(
          () => true,
          () => false,
        );
        this.mergedCache.set(key, isMerged);
      }
      if (isMerged) merged.add(run.id);
    }
    return merged;
  }

  /** The job's base branch tip as last fetched (origin/<base>), else the local ref; cached briefly. */
  async baseTip(job: Job): Promise<string | null> {
    const key = `${job.repoPath}\0${job.baseRef}`;
    const cached = this.baseTips.get(key);
    if (cached && cached.at > Date.now() - BASE_TIP_TTL_MS) return cached.tip;
    const branch = baseBranch(job.baseRef);
    let tip: string | null = null;
    for (const ref of [`refs/remotes/${REMOTE}/${branch}`, job.baseRef]) {
      tip = await git(job.repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => null);
      if (tip) break;
    }
    this.baseTips.set(key, { tip, at: Date.now() });
    return tip;
  }
}
