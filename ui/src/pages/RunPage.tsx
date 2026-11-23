import { Check, CornerDownRight, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Changes } from "@/components/Changes";
import { ItemPill } from "@/components/Items";
import { Markdown } from "@/components/Markdown";
import { CopyButton, ErrorNote, Field, Skeleton, StatusPill, Switch } from "@/components/ui";
import { AGENT_LABELS, ApiError, TRIGGER_LABELS, api, isActive, type Job, type Run } from "@/lib/api";
import { dateTime, duration, repoName, summarizePayload } from "@/lib/format";
import { groupItems, itemFields, itemTitle, type Item } from "@/lib/items";
import { VERDICT_LABELS, parseVerdict, splitReply, type Verdict } from "@/lib/report";
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
  const [actionError, setActionError] = useState<string | null>(null);
  const jobId = run?.jobId;
  const jobRuns = usePoll(() => (jobId === undefined ? Promise.resolve(null) : api.runs(jobId, 200)), 5000, [jobId]);

  useEffect(() => {
    if (jobId === undefined) return;
    let stale = false;
    api.job(jobId).then(
      (loaded) => !stale && setJob(loaded),
      () => !stale && setJob(null),
    );
    return () => {
      stale = true;
    };
  }, [jobId]);

  const item = useMemo(() => {
    if (!jobRuns.data || !run) return null;
    // Lists leave out full summaries; this run's own copy has its summary.
    const runs = jobRuns.data.map((r) => (r.id === run.id ? { ...r, ...run } : r));
    if (!runs.some((r) => r.id === run.id)) runs.push(run);
    return groupItems(runs).find((i) => i.runs.some((r) => r.id === run.id)) ?? null;
  }, [jobRuns.data, run]);

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await Promise.all([refresh(), jobRuns.refresh()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error && !run) return <ErrorNote error={error} />;
  if (!run) return <Skeleton rows={4} />;

  const active = isActive(run.status);
  const { report, reply } = splitReply(run.summary ?? "");
  const hasChanges = (run.commits ?? 0) > 0 && run.branch !== null;
  const itemFinished = item !== null && !item.runs.some((r) => isActive(r.status));
  const failedSilently = (run.status === "failed" || run.status === "timed_out") && !report;
  const log = (
    <Disclosure key={`log-${run.id}`} title="Log" defaultOpen={active || failedSilently}>
      <LogView key={run.id} runId={run.id} live={active} />
    </Disclosure>
  );
  const newer = item && item.latest.id !== run.id ? item.latest : null;

  return (
    <article className="mx-auto grid max-w-[880px] gap-8">
      <RunHeader
        run={run}
        job={job}
        item={item}
        actions={
          <>
            {active && run.status !== "awaiting_approval" && (
              <button type="button" className="btn btn-danger" onClick={() => void act(() => api.cancelRun(run.id))}>
                <Square aria-hidden className="size-3.5" />
                {run.status === "queued" ? "Cancel" : "Stop run"}
              </button>
            )}
            {itemFinished && item.state !== "merged" && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void act(() => api.markClosed(item.latest.id, item.latest.closedAt === null))}
              >
                {item.latest.closedAt === null ? "Close item" : "Reopen item"}
              </button>
            )}
          </>
        }
      />

      {newer && (
        <p className="-mt-4 text-[13px] text-fog">
          A newer run continues this item:{" "}
          <Link to={`/runs/${newer.id}`} className="font-semibold text-amber hover:underline">
            run #{newer.id}
            {!isActive(newer.status) && listVerdict(newer) !== "unknown"
              ? ` · ${VERDICT_LABELS[listVerdict(newer)]}`
              : isActive(newer.status)
                ? " · in progress"
                : ""}
          </Link>
        </p>
      )}

      <ErrorNote error={actionError ?? run.error} />

      {run.status === "awaiting_approval" && (
        <Approval
          run={run}
          job={job}
          onApprove={() => void act(() => api.approveRun(run.id))}
          onDismiss={() => void act(() => api.cancelRun(run.id))}
        />
      )}

      {run.instructions !== null && (
        <Section title="Your follow-up instructions">
          <p className="max-w-[72ch] text-[15px] leading-relaxed whitespace-pre-wrap text-bone">{run.instructions}</p>
        </Section>
      )}

      {(run.status === "running" || run.status === "queued") && (
        <p className="text-[14px] text-fog">
          {run.status === "running"
            ? `${AGENT_LABELS[run.agent]} is working. Its report appears here when it finishes; the live log is below.`
            : "Waiting for a free slot. It starts as soon as another run finishes."}
        </p>
      )}

      {!active && (report || run.status === "succeeded") && (
        <Section title="What the agent found">
          {report ? <Markdown text={report} /> : <p className="text-[14px] text-fog">The agent printed no report.</p>}
        </Section>
      )}

      {reply && item && (
        <Reply
          reply={reply}
          replied={item.replied}
          onChange={(value) =>
            void act(async () => {
              if (value) await api.markReplied(run.id, true);
              else await Promise.all(item.runs.filter((r) => r.repliedAt).map((r) => api.markReplied(r.id, false)));
            })
          }
        />
      )}

      {hasChanges && !active && <Changes run={run} job={job} />}

      {/* A failure without a report: the log is the evidence, so it comes before the follow-up. */}
      {failedSilently && log}

      {!active && <FollowUp key={run.id} run={run} job={job} item={item} verdict={parseVerdict(run.summary)} />}

      <div className="grid gap-2">
        <RunDetails run={run} job={job} />
        {run.payload && (
          <Disclosure title={item?.root.trigger === "watch" || run.trigger === "watch" ? "Raw report" : "Raw payload"}>
            <pre className="log-view overflow-x-auto px-4 py-3 whitespace-pre-wrap text-bone">{run.payload}</pre>
          </Disclosure>
        )}
        {!failedSilently && log}
      </div>
    </article>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A collapsible section. `defaultOpen` applies on mount only, so a re-render never folds what the reader opened. */
function Disclosure({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.open = defaultOpen;
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <details ref={ref} className="group overflow-hidden rounded-[12px] border border-steel/30">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[13px] font-semibold text-fog hover:text-bone">
        {title}
      </summary>
      <div className="border-t border-steel/30">{children}</div>
    </details>
  );
}

/** A run's verdict from what lists carry: its whole report when loaded, else its headline and verdict line. */
function listVerdict(run: Run): Verdict {
  return parseVerdict(run.summary ?? ([run.summaryHeadline, run.summaryVerdict].filter(Boolean).join("\n") || null));
}

const RUN_PILL: Record<Verdict, string> = {
  implemented: "pill-green",
  fixed: "pill-green",
  needs_decision: "pill-amber",
  cant_reproduce: "pill-muted",
  duplicate: "pill-muted",
  not_actionable: "pill-muted",
  unknown: "pill-green",
};

/** This run's outcome: its verdict when it succeeded, otherwise its status. */
function RunPill({ run }: { run: Run }) {
  if (run.status !== "succeeded") return <StatusPill status={run.status} />;
  const verdict = parseVerdict(run.summary);
  const [label, tone] = run.merged
    ? ["Merged", "pill-violet"]
    : verdict !== "unknown"
      ? [VERDICT_LABELS[verdict], RUN_PILL[verdict]]
      : (run.commits ?? 0) > 0
        ? ["Changes on branch", "pill-green"]
        : ["No changes", "pill-muted"];
  return (
    <span className={`pill ${tone}`}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function RunHeader({ run, job, item, actions }: { run: Run; job: Job | null; item: Item | null; actions: ReactNode }) {
  const now = useNow(1000);
  const { reference, kind } = itemFields(item?.root ?? run);
  const title = item ? itemTitle(item, job?.name) : (summarizePayload(run.payload).headline ?? job?.name ?? `Run #${run.id}`);
  return (
    <header className="grid gap-3">
      <Link to="/" className="justify-self-start text-[13px] text-fog hover:text-bone">
        ← Inbox
      </Link>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-fog">
        {reference && <span className="chip chip-mono">{reference}</span>}
        {kind && <span className="chip capitalize">{kind}</span>}
        {job && (
          <Link to={`/jobs/${job.id}`} className="hover:text-bone">
            {job.name}
          </Link>
        )}
      </div>
      <h1 className="run-title break-words">{title}</h1>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-fog">
          <RunPill run={run} />
          <span>
            Run #{run.id}
            {run.followUpOf !== null && ` · follow-up of #${run.followUpOf}`}
            {run.attempt > 1 && ` · attempt ${run.attempt}`}
            {run.startedAt && ` · ${duration(run.startedAt, run.finishedAt, now)}`} · {AGENT_LABELS[run.agent]}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      {item && item.runs.length > 1 && <Thread item={item} current={run.id} />}
    </header>
  );
}

/** The item's runs in order, so a triage and its follow-ups read as one thread. */
function Thread({ item, current }: { item: Item; current: number }) {
  return (
    <nav aria-label="Runs for this item" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <ol className="flex flex-wrap items-center gap-1.5">
        {item.runs.map((r, index) => (
          <li key={r.id} className="flex items-center gap-1.5">
            {index > 0 && (
              <span aria-hidden className="text-fog">
                →
              </span>
            )}
            <Link
              to={`/runs/${r.id}`}
              aria-current={r.id === current ? "page" : undefined}
              className={`chip ${r.id === current ? "chip-current" : "hover:text-bone"}`}
            >
              #{r.id} {r.followUpOf !== null ? "Follow-up" : r.retryOf !== null ? "Retry" : TRIGGER_LABELS[r.trigger]}
              {!isActive(r.status) && r.status !== "succeeded"
                ? ` · ${r.status.replace("_", " ")}`
                : listVerdict(r) !== "unknown"
                  ? ` · ${VERDICT_LABELS[listVerdict(r)]}`
                  : ""}
            </Link>
          </li>
        ))}
      </ol>
      {/* The item's state, when it differs from what this run's own pill says. */}
      {item.latest.id !== current && <ItemPill item={item} />}
    </nav>
  );
}

const APPROVAL_REASONS: Partial<Record<Run["trigger"], string>> = {
  watch: "The job's watch found a new item.",
  webhook: "The job's webhook received a request.",
  schedule: "The job's schedule is due.",
};

/** Says what approving a waiting run will do, and what it was started for, next to the decision. */
function Approval({ run, job, onApprove, onDismiss }: { run: Run; job: Job | null; onApprove: () => void; onDismiss: () => void }) {
  const { fields } = summarizePayload(run.payload);
  const paused = job?.enabled === false;
  return (
    <section aria-labelledby="approval-title" className="grid gap-4 border-t-2 border-amber/70 pt-5">
      <div className="grid gap-1.5">
        <h2 id="approval-title" className="section-heading">
          Start this run?
        </h2>
        <p className="max-w-[72ch] text-[14px] leading-relaxed text-fog">
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
          , following the job's instructions{run.payload ? " for this item" : ""}. It never merges or deploys.
        </p>
      </div>

      {fields.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-[13px]">
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

      {job && (
        <Disclosure title="Instructions the agent will follow">
          <pre className="log-view max-h-72 overflow-auto px-4 py-3 whitespace-pre-wrap text-bone">{job.prompt}</pre>
        </Disclosure>
      )}

      <div className="sticky-actions flex flex-wrap items-center justify-end gap-2">
        {paused && <span className="mr-auto text-[12px] text-fog">The job is paused. Resume it to approve its runs.</span>}
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          <button type="button" className="btn btn-ghost" onClick={onDismiss}>
            Dismiss
          </button>
          <button type="button" className="btn btn-primary" disabled={paused} onClick={onApprove}>
            <Check aria-hidden className="size-3.5" />
            Approve and start
          </button>
        </div>
      </div>
    </section>
  );
}

function Reply({ reply, replied, onChange }: { reply: string; replied: boolean; onChange: (value: boolean) => void }) {
  return (
    <Section title="Suggested reply to the reporter" aside={<CopyButton value={reply} label="Copy reply" />}>
      <blockquote className="max-w-[72ch] border-l-2 border-steel/60 pl-4 text-[15px] leading-relaxed whitespace-pre-wrap text-bone">
        {reply}
      </blockquote>
      <div className="flex items-center justify-between gap-4 rounded-[12px] border border-steel/30 px-4 py-3">
        <div>
          <div className="text-[13px] font-semibold">Replied</div>
          <p className="text-[12px] text-fog">pi-jobs doesn't send replies. Copy the text, send it yourself, then mark it replied.</p>
        </div>
        <Switch checked={replied} onChange={onChange} label="Replied to the reporter" />
      </div>
    </Section>
  );
}

const PRESETS: {
  id: string;
  label: string;
  text: (run: Run) => string;
  when: (run: Run, verdict: Verdict, latest: boolean) => boolean;
}[] = [
  {
    id: "implement",
    label: "Implement the proposal",
    text: () =>
      "Implement the proposal from your report. Keep the change minimal, add or update tests, run the project's checks and commit.",
    when: (_run, verdict, latest) => verdict === "needs_decision" && latest,
  },
  {
    id: "review",
    label: "Address review notes",
    text: () => "Address these review notes on the current branch. Keep the existing commits and add new ones:\n- ",
    when: (run) => (run.commits ?? 0) > 0,
  },
  {
    id: "reproduce",
    label: "Try to reproduce again",
    text: () =>
      "Try again to reproduce the report. Add logging or a failing test that captures the expected behaviour, and report exactly what you observed.",
    when: (_run, verdict) => verdict === "cant_reproduce",
  },
  {
    id: "rebase",
    label: "Rebase on the base branch",
    text: () => "Rebase this branch onto the job's base branch, resolve conflicts, rerun the checks and report what changed.",
    when: (run) => (run.commits ?? 0) > 0 && !run.merged,
  },
  {
    id: "retry",
    label: "Diagnose and retry",
    text: (run) =>
      `The previous attempt failed${run.error ? ` (${run.error})` : ""}. Diagnose the cause, fix it and finish the original task.`,
    when: (run) => run.status === "failed" || run.status === "timed_out",
  },
  {
    id: "reply",
    label: "Shorten the reply",
    text: () => "Rewrite the suggested reply to the reporter in two sentences at most, plain and friendly, without technical detail.",
    when: (run) => splitReply(run.summary ?? "").reply !== null,
  },
];

/** Starts a run that continues this one: from its result, with new instructions and this run as context. */
function FollowUp({ run, job, item, verdict }: { run: Run; job: Job | null; item: Item | null; verdict: Verdict }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // "Implement it" in the Inbox links here with ?followUp=implement: start with that preset, never submit.
  const requested = PRESETS.find((p) => p.id === params.get("followUp"));
  const [instructions, setInstructions] = useState(() => requested?.text(run) ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // Presets that continue the item fit only its newest run; an older run's proposal may be done already.
  const latest = item === null || item.latest.id === run.id;
  const presets = PRESETS.filter((preset) => preset.when(run, verdict, latest));

  const insert = (text: string) => {
    setInstructions((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text));
    window.requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  };

  useEffect(() => {
    if (!params.has("followUp")) return;
    const box = boxRef.current;
    if (requested && box) {
      box.scrollIntoView({ block: "center" });
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    setParams({}, { replace: true });
    // Only on arrival: the parameter is removed right away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const next = await api.followUp(run.id, instructions);
      navigate(`/runs/${next.id}`);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStarting(false);
    }
  };
  const fieldError = error instanceof ApiError ? error.fields.instructions : undefined;
  const from = (run.commits ?? 0) > 0 ? "this run's branch" : job ? job.baseRef : "the job's base branch";
  return (
    <Section title="Follow up">
      <p className="-mt-1 max-w-[72ch] text-[14px] leading-relaxed text-fog">
        Starts a new run from {from} with your instructions. The agent also gets this run's instructions
        {run.payload ? ", item" : ""} and report. Nothing merges or deploys.
      </p>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button key={preset.id} type="button" className="btn btn-ghost btn-sm" onClick={() => insert(preset.text(run))}>
              {preset.label}
            </button>
          ))}
        </div>
      )}
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <Field label="Instructions" error={fieldError}>
          {(p) => (
            <textarea
              {...p}
              ref={boxRef}
              className="field min-h-[110px] resize-y leading-relaxed"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && instructions.trim()) {
                  e.preventDefault();
                  void start();
                }
              }}
              placeholder="What should the agent do next?"
            />
          )}
        </Field>
        {error && !fieldError && <ErrorNote error={error} />}
        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary" disabled={starting || !instructions.trim()}>
            <CornerDownRight aria-hidden className="size-3.5" />
            {starting ? "Starting…" : "Start follow-up"}
          </button>
        </div>
      </form>
    </Section>
  );
}

function RunDetails({ run, job }: { run: Run; job: Job | null }) {
  const now = useNow(1000);
  const rows: [string, ReactNode][] = [
    ["Trigger", run.followUpOf !== null ? `Follow-up of #${run.followUpOf}` : TRIGGER_LABELS[run.trigger]],
    ["Agent", AGENT_LABELS[run.agent]],
    ["Created", dateTime(run.createdAt)],
    [
      "Started",
      run.startedAt
        ? dateTime(run.startedAt)
        : run.status === "awaiting_approval"
          ? "Waiting for approval"
          : run.status === "queued" && run.notBefore && Date.parse(run.notBefore) > now
            ? `Retry at ${dateTime(run.notBefore)}`
            : "Not started",
    ],
    ["Duration", duration(run.startedAt, run.finishedAt, now)],
    ["Exit code", run.exitCode ?? "—"],
    ["Check", run.checkStatus ? (run.checkStatus === "passed" ? "Passed" : "Failed") : "—"],
  ];
  if (run.retryOf !== null) {
    rows.push([
      "Retry of",
      <Link key="retry" to={`/runs/${run.retryOf}`} className="hover:text-bone">
        #{run.retryOf}
      </Link>,
    ]);
  }
  if (job) rows.push(["Repository", <span key="repo" className="font-mono text-[12px]">{job.repoPath}</span>]);
  if (run.worktree) rows.push(["Worktree (kept)", <span key="wt" className="font-mono text-[12px]">{run.worktree}</span>]);
  return (
    <Disclosure title="Run details">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 px-4 py-3 text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fog">{label}</dt>
            <dd className="min-w-0 truncate text-bone">{value}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
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
      className="log-view max-h-[min(62vh,640px)] min-h-24 overflow-auto px-4 py-3 whitespace-pre-wrap break-words text-bone/90"
    >
      {text || (live ? "Waiting for output…" : "No output.")}
    </pre>
  );
}
