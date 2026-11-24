import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyButton, ErrorNote, Skeleton } from "@/components/ui";
import { api, type ChangedFile, type Job, type Run, type RunChanges } from "@/lib/api";

/** Files expand by default only while the whole patch is small enough to read at a glance. */
const OPEN_BY_DEFAULT_BYTES = 40_000;
const OPEN_BY_DEFAULT_FILES = 3;
/** Longer file diffs start closed, even on a small patch. */
const LONG_FILE_LINES = 400;

/**
 * A run's changed files with their diffs, and the git commands to review the branch (and merge it by
 * hand, unless the item is already released or merged).
 */
export function Changes({ run, job, wholeBranch = false, shipped = false }: { run: Run; job: Job | null; wholeBranch?: boolean; shipped?: boolean }) {
  const followUp = run.followUpOf !== null;
  // On an item's page the whole branch is what gets merged, so it comes first.
  const [sinceBase, setSinceBase] = useState(wholeBranch && followUp);
  // Results are kept with the request they answer, so a stale one is never shown for another.
  const request = `${run.id}:${run.headCommit}:${sinceBase}`;
  const [loaded, setLoaded] = useState<{ request: string; changes: RunChanges | null; error: Error | null } | null>(null);
  const changes = loaded?.request === request ? loaded.changes : null;
  const error = loaded?.request === request ? loaded.error : null;

  useEffect(() => {
    let stale = false;
    api.changes(run.id, sinceBase).then(
      (result) => !stale && setLoaded({ request, changes: result, error: null }),
      (err: unknown) => !stale && setLoaded({ request, changes: null, error: err instanceof Error ? err : new Error(String(err)) }),
    );
    return () => {
      stale = true;
    };
  }, [run.id, sinceBase, request]);

  const totals = changes?.files.reduce(
    (sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
  const commits = run.commits ?? 0;

  return (
    <section aria-labelledby="changes-title" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="changes-title" className="section-heading">
          Changes
          <span className="ml-2 text-[13px] font-medium text-fog">
            {/* A run's commit count covers its own commits, not the whole branch's. */}
            {!sinceBase && `${commits} commit${commits === 1 ? "" : "s"}`}
            {changes && `${sinceBase ? "" : " · "}${changes.files.length} file${changes.files.length === 1 ? "" : "s"}`}
            {totals && (
              <>
                {" · "}
                <span className="text-green">+{totals.additions}</span> <span className="text-red">−{totals.deletions}</span>
              </>
            )}
          </span>
        </h2>
        {followUp && (
          <div role="group" aria-label="Which changes" className="segmented">
            <button type="button" aria-pressed={sinceBase} onClick={() => setSinceBase(true)}>
              Whole branch
            </button>
            <button type="button" aria-pressed={!sinceBase} onClick={() => setSinceBase(false)}>
              Run #{run.id} only
            </button>
          </div>
        )}
      </div>

      {run.merged && (
        <p className="flex items-center gap-2 text-[13px] text-violet">
          <span aria-hidden className="size-1.5 rounded-full bg-violet" />
          Merged into {baseBranch(job)}.
        </p>
      )}
      {run.checkStatus ? (
        <p className={`text-[13px] ${run.checkStatus === "passed" ? "text-green" : "text-red"}`}>
          {run.checkStatus === "passed" ? "Check passed" : "Check failed"}: <span className="font-mono">{job?.checkCommand}</span>
        </p>
      ) : (
        job &&
        !job.checkCommand && <p className="text-[13px] text-amber">No check configured: that the tests pass is the agent's word. Add a check command to the job.</p>
      )}

      <ErrorNote error={error} />
      {!changes && !error ? <Skeleton rows={2} /> : changes && <FileList changes={changes} />}
      {changes?.truncated && (
        <p className="text-[13px] text-fog">The diff is too large to show in full. Review the rest with the commands below.</p>
      )}
      <GitCommands run={run} job={job} shipped={shipped} />
    </section>
  );
}

/** Tests and docs after the code they cover. */
const SUPPORTING = /(^|\/)(tests?|__tests__|docs?)\/|\.(test|spec)\.[^/]+$|\.md$/i;

function FileList({ changes }: { changes: RunChanges }) {
  const patches = splitPatch(changes.patch);
  // Paired before sorting: patches follow git's order.
  const files = changes.files
    .map((file, index) => ({ file, patch: patches[index] ?? "", index }))
    .sort((a, b) => Number(SUPPORTING.test(a.file.path)) - Number(SUPPORTING.test(b.file.path)) || a.index - b.index);
  const wide = typeof window !== "undefined" && window.matchMedia?.("(min-width: 640px)").matches;
  const small = changes.patch.length < OPEN_BY_DEFAULT_BYTES;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  return (
    <div className="grid gap-2">
      {files.length > 1 && (
        <button type="button" className="justify-self-end text-[12px] font-semibold text-fog hover:text-bone" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Collapse all" : "Expand all"}
        </button>
      )}
      <ul className="grid gap-2">
        {files.map(({ file, patch, index }, position) => {
          const open = expanded ?? (Boolean(wide) && small && position < OPEN_BY_DEFAULT_FILES && patch.split("\n").length < LONG_FILE_LINES);
          // Expand all and Collapse all remount the rows with that state; a row can still be toggled after.
          return <FileDiff key={`${file.path}-${index}-${String(expanded)}`} file={file} patch={patch} defaultOpen={open} />;
        })}
      </ul>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed" };

function FileDiff({ file, patch, defaultOpen }: { file: ChangedFile; patch: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hunks = patch.slice(patch.search(/^@@/m) === -1 ? patch.length : patch.search(/^@@/m));
  return (
    <li className="overflow-hidden rounded-[12px] border border-steel/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2.5 bg-inkwell/50 px-3.5 text-left hover:bg-inkwell"
      >
        <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-fog transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        <span aria-hidden className="w-4 shrink-0 font-mono text-[11px] font-bold text-fog" title={STATUS_LABELS[file.status] ?? file.status}>
          {file.status}
        </span>
        <span className="sr-only">{STATUS_LABELS[file.status] ?? file.status}:</span>
        {/* Cut from the left, so the file name stays readable on a phone. */}
        <span className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px] text-bone [direction:rtl]" title={file.path}>
          <bdi>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</bdi>
        </span>
        <span className="shrink-0 font-mono text-[12px] tabular-nums">
          {file.additions === null ? (
            <span className="text-fog">binary</span>
          ) : (
            <>
              <span className="text-green">+{file.additions}</span> <span className="text-red">−{file.deletions}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="diff-view overflow-x-auto border-t border-steel/30">
          {hunks ? (
            <pre>
              {hunks.split("\n").map((line, n) => (
                <span key={n} className={lineClass(line)}>
                  {line || " "}
                  {"\n"}
                </span>
              ))}
            </pre>
          ) : (
            <p className="px-3.5 py-2.5 text-[12px] text-fog">No text changes to show.</p>
          )}
        </div>
      )}
    </li>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "";
}

/** One patch chunk per file, in git's order (the same order as the file list). */
function splitPatch(patch: string): string[] {
  return patch.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
}

function baseBranch(job: Job | null): string {
  return job ? job.baseRef.replace(/^origin\//, "") : "the base branch";
}

function GitCommands({ run, job, shipped }: { run: Run; job: Job | null; shipped: boolean }) {
  if (!run.branch || !job) return null;
  const repo = quote(job.repoPath);
  const base = baseBranch(job);
  const rows = [
    { label: "Branch", value: run.branch },
    { label: "Review in a terminal", value: `git -C ${repo} log --stat ${run.baseCommit?.slice(0, 12) ?? base}..${run.branch}` },
    { label: "Merge", value: `git -C ${repo} switch ${base} && git -C ${repo} merge --no-ff ${run.branch}` },
    { label: "Push (deploys where pushing deploys)", value: `git -C ${repo} push origin ${base}` },
  ];
  if (shipped) rows.splice(2);
  if (run.pushedTo) rows.splice(1, 0, { label: "Fetch on another machine", value: `git fetch ${run.pushedTo} ${run.branch}` });
  return (
    <details className="group rounded-[12px] border border-steel/30">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[13px] font-semibold text-fog hover:text-bone">
        Git commands
      </summary>
      <div className="grid gap-px border-t border-steel/30">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 bg-inkwell/40 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] text-fog">{row.label}</div>
              <div className="truncate font-mono text-[12px] text-bone" title={row.value}>
                {row.value}
              </div>
            </div>
            <CopyButton value={row.value} />
          </div>
        ))}
        <p className="bg-inkwell/40 px-4 py-2.5 text-[12px] text-fog">
          {shipped
            ? "This item is already out. These commands are for looking back at the branch."
            : "Approve & release merges and releases it for you. To do it by hand instead: merge, run the app's checks, then push."}
        </p>
      </div>
    </details>
  );
}

function quote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
