import { Check, Square } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { CopyButton, ErrorNote, PageHeader, Skeleton, StatusPill } from "@/components/ui";
import { AGENT_LABELS, TRIGGER_LABELS, api, isActive, type Job, type Run } from "@/lib/api";
import { dateTime, duration, repoName, summarizePayload } from "@/lib/format";
import { useNow, usePoll } from "@/lib/usePoll";

const MAX_LOG_CHARS = 2_000_000;

export function RunPage() {
  const runId = Number(useParams().id);
  const { data: run, error, refresh } = usePoll(
    () => api.run(runId),
    (latest) => (latest && !isActive(latest.status) ? null : 2000),
    [runId],
  );
  const [job, setJob] = useState<Job | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const now = useNow(1000);

  const jobId = run?.jobId;
  useEffect(() => {
    if (jobId !== undefined) api.job(jobId).then(setJob, () => setJob(null));
  }, [jobId]);

  const act = async (action: (id: number) => Promise<Run>) => {
    setCancelError(null);
    try {
      await action(runId);
      await refresh();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error && !run) return <ErrorNote error={error} />;
  if (!run) return <Skeleton rows={4} />;

  return (
    <>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <span>Run #{run.id}</span>
            <StatusPill status={run.status} />
          </span>
        }
        meta={
          job ? (
            <Link to={`/jobs/${job.id}`} className="hover:text-bone">
              ← {job.name}
            </Link>
          ) : (
            <Link to="/runs" className="hover:text-bone">
              ← All runs
            </Link>
          )
        }
        actions={
          run.status !== "awaiting_approval" &&
          isActive(run.status) && (
            <button type="button" className="btn btn-danger" onClick={() => void act(api.cancelRun)}>
              <Square aria-hidden className="size-3.5" />
              {run.status === "queued" ? "Cancel" : "Stop run"}
            </button>
          )
        }
      />

      <div className="grid gap-6">
        <ErrorNote error={cancelError ?? run.error} />
        {run.status === "awaiting_approval" && (
          <Approval run={run} job={job} onApprove={() => void act(api.approveRun)} onDismiss={() => void act(api.cancelRun)} />
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-[14px] border border-steel/40 bg-inkwell/40 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
          <Meta label="Trigger">
            {TRIGGER_LABELS[run.trigger]}
            {run.retryOf !== null && (
              <>
                {" · "}
                <Link to={`/runs/${run.retryOf}`} className="text-fog hover:text-bone">
                  retry of #{run.retryOf}
                </Link>
              </>
            )}
          </Meta>
          <Meta label="Agent">{AGENT_LABELS[run.agent]}</Meta>
          <Meta label="Started">{run.startedAt
              ? dateTime(run.startedAt)
              : run.status === "awaiting_approval"
                ? "Waiting for approval"
                : run.status === "queued" && run.notBefore && Date.parse(run.notBefore) > now
                  ? `Retry at ${dateTime(run.notBefore)}`
                  : "Waiting for a slot"}</Meta>
          <Meta label="Duration">
            <span className="tabular-nums">{duration(run.startedAt, run.finishedAt, now)}</span>
          </Meta>
          <Meta label="Exit code">{run.exitCode ?? "—"}</Meta>
          <Meta label="Check">
            {run.checkStatus ? (
              <span className={run.checkStatus === "passed" ? "text-green" : "text-red"}>
                {run.checkStatus === "passed" ? "Passed" : "Failed"}
              </span>
            ) : (
              "—"
            )}
          </Meta>
        </dl>

        <Outcome run={run} job={job} />

        {run.payload && (
          <details className="group rounded-[12px] border border-steel/40">
            <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[13px] font-semibold text-fog hover:text-bone">
              {run.trigger === "watch" ? "Raw watch item" : "Raw webhook payload"}
            </summary>
            <pre className="log-view overflow-x-auto rounded-b-[12px] border-t border-steel/40 px-4 py-3 whitespace-pre-wrap text-bone">
              {run.payload}
            </pre>
          </details>
        )}

        <section className="grid gap-2">
          <h2 className="section-label">Log</h2>
          <LogView key={run.id} runId={run.id} live={isActive(run.status)} />
        </section>
      </div>
    </>
  );
}

const APPROVAL_REASONS: Partial<Record<Run["trigger"], string>> = {
  watch: "The job's watch found a new item.",
  webhook: "The job's webhook received a request.",
  schedule: "The job's schedule is due.",
};

/** Says what approving a waiting run will do, and what it was started for, next to the decision. */
function Approval({ run, job, onApprove, onDismiss }: { run: Run; job: Job | null; onApprove: () => void; onDismiss: () => void }) {
  const { headline, fields } = summarizePayload(run.payload);
  const paused = job?.enabled === false;
  return (
    <section aria-labelledby="approval-title" className="grid gap-4 rounded-[14px] border border-amber/45 bg-amber/5 p-5">
      <div className="grid gap-1.5">
        <h2 id="approval-title" className="text-[16px] font-bold">
          Start this run?
        </h2>
        <p className="text-[13px] leading-relaxed text-fog">
          {APPROVAL_REASONS[run.trigger]} Approving starts {AGENT_LABELS[run.agent]}
          {job ? (
            <>
              {" "}
              on a new branch of <span className="font-mono text-bone">{repoName(job.repoPath)}</span> from{" "}
              <span className="font-mono text-bone">{job.baseRef}</span>
            </>
          ) : (
            " on a new branch"
          )}
          , following the job's instructions{run.payload ? " for the item below" : ""}. It never merges or deploys. Dismiss
          cancels the run without starting it.
        </p>
      </div>

      {(headline || fields.length > 0) && (
        <div className="grid gap-3 rounded-[12px] border border-steel/40 bg-inkwell/60 px-4 py-3">
          {headline && <p className="text-[15px] leading-snug font-semibold break-words text-bone">{headline}</p>}
          {fields.length > 0 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
              {fields.map((field) => (
                <div key={field.label} className="contents">
                  <dt className="text-fog">{field.label}</dt>
                  <dd className="truncate text-bone" title={field.value}>
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {job && (
        <details className="group rounded-[12px] border border-steel/40">
          <summary className="flex min-h-10 cursor-pointer items-center px-4 text-[13px] font-semibold text-fog hover:text-bone">
            Instructions the agent will follow
          </summary>
          <pre className="log-view max-h-72 overflow-auto rounded-b-[12px] border-t border-steel/40 px-4 py-3 whitespace-pre-wrap text-bone">
            {job.prompt}
          </pre>
        </details>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {paused && <span className="mr-auto text-[12px] text-fog">The job is paused. Resume it to approve its runs.</span>}
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>
          Dismiss
        </button>
        <button type="button" className="btn btn-primary" disabled={paused} onClick={onApprove}>
          <Check aria-hidden className="size-3.5" />
          Approve and start
        </button>
      </div>
    </section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="section-label">{label}</dt>
      <dd className="mt-1 truncate text-[14px]">{children}</dd>
    </div>
  );
}

function Outcome({ run, job }: { run: Run; job: Job | null }) {
  if (isActive(run.status)) return null;
  const rows: { label: string; value: string; copy?: string }[] = [];
  if (run.branch) {
    const pushed = run.pushedTo ? ` · pushed to ${run.pushedTo}` : "";
    rows.push({ label: `Branch · ${run.commits ?? 0} commit${run.commits === 1 ? "" : "s"}${pushed}`, value: run.branch });
    if (run.pushedTo) rows.push({ label: "Fetch on another machine", value: `git fetch ${run.pushedTo} ${run.branch}` });
    if (job) {
      const review = `git -C ${quote(job.repoPath)} log --stat ${run.baseCommit?.slice(0, 12) ?? job.baseRef}..${run.branch}`;
      rows.push({ label: "Review", value: review });
    }
  }
  if (run.worktree) rows.push({ label: "Worktree (kept for inspection)", value: run.worktree });
  if (rows.length === 0) {
    return run.status === "succeeded" ? (
      <p className="text-[14px] text-fog">The agent made no changes, so no branch was kept.</p>
    ) : null;
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-[14px] border border-steel/40">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-3 bg-inkwell/40 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="section-label">{row.label}</div>
            <div className="truncate font-mono text-[12px] text-bone" title={row.value}>
              {row.value}
            </div>
          </div>
          <CopyButton value={row.value} />
        </div>
      ))}
    </div>
  );
}

function LogView({ runId, live }: { runId: number; live: boolean }) {
  const [text, setText] = useState("");
  const offsetRef = useRef(0);
  const doneRef = useRef(false);
  const boxRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        // Drain everything available, then wait before polling again.
        for (;;) {
          const chunk = await api.log(runId, offsetRef.current);
          if (stopped) return;
          offsetRef.current = chunk.offset;
          doneRef.current = chunk.done;
          if (chunk.text) setText((current) => (current + chunk.text).slice(-MAX_LOG_CHARS));
          if (chunk.offset >= chunk.size) break;
        }
      } catch {
        // Try again on the next tick.
      }
      if (!stopped && !doneRef.current) timer = window.setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [runId, live]);

  useEffect(() => {
    const box = boxRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={boxRef}
      onScroll={(e) => {
        const box = e.currentTarget;
        followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      }}
      className="log-view h-[min(62vh,640px)] overflow-auto rounded-[14px] border border-steel/40 px-4 py-3 whitespace-pre-wrap break-words text-bone/90"
    >
      {text || (live ? "Waiting for output…" : "No output.")}
    </pre>
  );
}

function quote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
