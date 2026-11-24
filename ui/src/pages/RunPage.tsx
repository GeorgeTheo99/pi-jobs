import { Check, MessageCircleQuestion, MessagesSquare, Rocket, Square, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Changes } from "@/components/Changes";
import { ItemPill } from "@/components/Items";
import { Markdown } from "@/components/Markdown";
import { CopyButton, ErrorNote, Skeleton, StatusPill, Switch } from "@/components/ui";
import { agentLabel, ApiError, TRIGGER_LABELS, api, isActive, isShipMode, type Job, type Run, type RunMode } from "@/lib/api";
import { dateTime, duration, relativeTime, repoName, summarizePayload } from "@/lib/format";
import { canShip, groupItems, itemFields, itemTitle, type Item } from "@/lib/items";
import { VERDICT_LABELS, parseVerdict, splitReply, type Verdict } from "@/lib/report";
import { useNow, usePoll, useRefreshOnChange } from "@/lib/usePoll";

const MAX_LOG_CHARS = 2_000_000;

/**
 * An item's page: the conversation of its runs (the triggered run, the owner's questions and change
 * requests, the agent's answers and reports), its changes, and a composer for the next message. The
 * run in the URL is the selected one, whose details and log are at the bottom.
 */
export function RunPage() {
  const runId = Number(useParams().id);
  const thread = usePoll(
    () => api.thread(runId),
    (latest) => (latest?.some((r) => isActive(r.status)) ? 2000 : 8000),
    [runId],
  );
  useRefreshOnChange(thread.refresh);
  const runs = thread.data;
  const run = runs?.find((r) => r.id === runId) ?? null;
  const item = useMemo(() => (runs && runs.length > 0 ? (groupItems(runs)[0] ?? null) : null), [runs]);
  const [job, setJob] = useState<Job | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const jobId = run?.jobId;

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

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await thread.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  if (thread.error && !run) return <ErrorNote error={thread.error} />;
  if (!run || !item) return <Skeleton rows={4} />;

  const activeRun = item.runs.find((r) => isActive(r.status) && r.status !== "awaiting_approval") ?? null;
  const waiting = item.runs.find((r) => r.status === "awaiting_approval") ?? null;
  const itemFinished = !item.runs.some((r) => isActive(r.status));
  const replyRun = [...item.runs].reverse().find((r) => !isActive(r.status) && splitReply(r.summary ?? "").reply !== null);
  const reply = replyRun ? splitReply(replyRun.summary ?? "").reply : null;
  const selectedActive = isActive(run.status);
  const selectedSilent = (run.status === "failed" || run.status === "timed_out") && !run.summary;

  return (
    <article className="mx-auto grid max-w-[880px] gap-8">
      <ItemHeader
        item={item}
        job={job}
        actions={
          <>
            {activeRun && (
              <button type="button" className="btn btn-danger" onClick={() => void act(() => api.cancelRun(activeRun.id))}>
                <Square aria-hidden className="size-3.5" />
                {activeRun.status === "queued" ? "Cancel" : "Stop"}
              </button>
            )}
            <Link to={`/chats?runId=${item.latest.id}`} className="btn btn-ghost">
              <MessagesSquare aria-hidden className="size-3.5" />
              Chat about it
            </Link>
            {job && canShip(item, job) && (
              <button
                type="button"
                className={`btn ${item.state === "shipped" ? "btn-ghost" : "btn-primary"}`}
                title={job.releaseInstructions ? `${agentLabel(job.effectiveAgent)} releases this item's result by the job's release instructions` : `Runs ${job.shipCommand} on this item's result`}
                onClick={() => {
                  const commit = item.withChanges?.headCommit?.slice(0, 12) ?? "";
                  const how = job.releaseInstructions
                    ? `${agentLabel(job.effectiveAgent)} follows the job's release instructions and may merge, push, deploy and publish:\n\n${job.releaseInstructions}`
                    : `Runs: ${job.shipCommand}`;
                  if (!window.confirm(`Release this item's result (${commit})?\n\n${how}\n\nIt runs as you, with your credentials, and may do things that can't be undone.`)) return;
                  void act(() => api.ship(item.latest.id));
                }}
              >
                <Rocket aria-hidden className="size-3.5" />
                {isShipMode(item.latestWork.mode) ? "Release again" : "Approve & release"}
              </button>
            )}
            {itemFinished && item.state !== "merged" && item.state !== "shipped" && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void act(() => api.markClosed(item.latestWork.id, item.latestWork.closedAt === null))}
              >
                {item.latestWork.closedAt === null ? "Close item" : "Reopen item"}
              </button>
            )}
          </>
        }
      />

      <ErrorNote error={actionError} />

      {waiting && (
        <Approval
          run={waiting}
          job={job}
          onApprove={() => void act(() => api.approveRun(waiting.id))}
          onDismiss={() => void act(() => api.cancelRun(waiting.id))}
        />
      )}

      {!waiting && (
        <section aria-label="Conversation" className="grid gap-7">
          {item.runs.map((r) => (
            <Turn key={r.id} run={r} selected={r.id === run.id} latest={r.id === item.latest.id} />
          ))}
        </section>
      )}

      {reply && replyRun && (
        <Reply
          reply={reply}
          replied={item.replied}
          onChange={(value) =>
            void act(async () => {
              if (value) await api.markReplied(replyRun.id, true);
              else await Promise.all(item.runs.filter((r) => r.repliedAt).map((r) => api.markReplied(r.id, false)));
            })
          }
        />
      )}

      {item.withChanges?.branch && itemFinished && <Changes key={`changes-${item.withChanges.id}`} run={item.withChanges} job={job} wholeBranch />}

      {!waiting && job?.kind !== "command" && run.mode !== "command" && (
        <Composer
          key={`composer-${item.root.id}`}
          item={item}
          job={job}
          busy={activeRun}
          onStarted={() => void thread.refresh()}
        />
      )}

      <section aria-label={`Run #${run.id}`} className="grid gap-2">
        <h2 className="section-label">
          Run #{run.id}
          {item.runs.length > 1 && " (selected above)"}
        </h2>
        <RunDetails run={run} job={job} />
        {run.payload && (
          <Disclosure title={item.root.trigger === "watch" ? "Raw report" : "Raw payload"}>
            <pre className="log-view overflow-x-auto px-4 py-3 whitespace-pre-wrap text-bone">{run.payload}</pre>
          </Disclosure>
        )}
        <Disclosure key={`log-${run.id}`} title="Log" defaultOpen={selectedActive || selectedSilent}>
          <LogView key={run.id} runId={run.id} live={selectedActive} />
        </Disclosure>
      </section>
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


const RUN_PILL: Record<Verdict, string> = {
  implemented: "pill-green",
  fixed: "pill-green",
  needs_decision: "pill-amber",
  cant_reproduce: "pill-muted",
  duplicate: "pill-muted",
  not_actionable: "pill-muted",
  unknown: "pill-green",
};

/** A run's outcome: its verdict when a change run succeeded, "Answered" for a question, else its status. */
function RunPill({ run }: { run: Run }) {
  if (run.status !== "succeeded") return <StatusPill status={run.status} />;
  const verdict = parseVerdict(run.summary);
  const [label, tone] =
    run.mode === "command"
      ? ["Succeeded", "pill-green"]
      : isShipMode(run.mode)
      ? [run.mode === "release" ? "Released" : "Shipped", "pill-violet"]
      : run.mode === "ask"
      ? ["Answered", "pill-muted"]
      : run.merged
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

function ItemHeader({ item, job, actions }: { item: Item; job: Job | null; actions: ReactNode }) {
  const { reference, kind } = itemFields(item.root);
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
      <h1 className="run-title break-words">{itemTitle(item, job?.name)}</h1>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-fog">
          <ItemPill item={item} />
          <span>
            {item.runs.length} run{item.runs.length === 1 ? "" : "s"}
            {job && (job.kind === "command" ? ` · Command in ${repoName(job.repoPath)}` : ` · ${agentLabel(job.effectiveAgent)} on ${repoName(job.repoPath)}`)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
    </header>
  );
}

const STARTED_BY: Record<Run["trigger"], string> = {
  watch: "The job's watch found this report",
  webhook: "The job's webhook received this",
  schedule: "The job's schedule started this",
  manual: "Started with Run now",
};

/** One exchange: what the owner asked or asked for (or what started the item), then the agent's reply. */
function Turn({ run, selected, latest }: { run: Run; selected: boolean; latest: boolean }) {
  const now = useNow(1000);
  const active = isActive(run.status);
  const { report } = splitReply(run.summary ?? "");
  // Short replies show whole; long reports fold unless they are the newest or selected.
  const long = report.length > 280 || report.split("\n").length > 4;
  const [expanded, setExpanded] = useState(selected || latest || !long);
  const ask = run.mode === "ask";
  const release = run.mode === "release";
  if (run.mode === "ship") return <ShipTurn run={run} selected={selected} />;
  if (run.mode === "command") return <CommandTurn run={run} selected={selected} />;
  return (
    <div className="grid gap-3">
      {run.instructions !== null && run.retryOf === null ? (
        <div className="turn-you">
          <div className="turn-label">
            {ask ? (
              <MessageCircleQuestion aria-hidden className="size-3.5" />
            ) : release ? (
              <Rocket aria-hidden className="size-3.5" />
            ) : (
              <Wrench aria-hidden className="size-3.5" />
            )}
            {/* A release may come from the job's Release automatically, not the owner. */}
            {release ? "Release" : `You · ${ask ? "Ask" : "Make changes"}`} · {relativeTime(run.createdAt, now)}
          </div>
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-bone">{run.instructions}</p>
        </div>
      ) : (
        <p className="text-[12px] text-fog">
          {run.retryOf !== null
            ? `Retry of #${run.retryOf} (attempt ${run.attempt})`
            : `${STARTED_BY[run.trigger]} · ${relativeTime(run.createdAt, now)}`}
        </p>
      )}

      <div className={`turn-agent ${selected ? "turn-selected" : ""}`} aria-current={selected ? "true" : undefined}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-fog">
          <span className="turn-label">Agent</span>
          <RunPill run={run} />
          <Link to={`/runs/${run.id}`} className="font-mono hover:text-bone" title="Select this run for its details and log">
            #{run.id}
          </Link>
          {run.startedAt && <span>{duration(run.startedAt, run.finishedAt, now)}</span>}
          {(run.commits ?? 0) > 0 && (
            <span className="text-bone">
              +{run.commits} commit{run.commits === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {run.status === "queued" ? (
          <p className="text-[14px] text-fog">Waiting for a free slot. It starts as soon as another run finishes.</p>
        ) : run.status === "running" ? (
          <p className="text-[14px] text-fog">
            {ask ? "Looking into it…" : release ? "Releasing…" : "Working on it…"}{" "}
            {!selected && (
              <Link to={`/runs/${run.id}`} className="text-amber hover:underline">
                Watch the log
              </Link>
            )}
          </p>
        ) : report ? (
          <div className={expanded ? "" : "turn-collapsed"}>
            <Markdown text={report} />
          </div>
        ) : run.error ? (
          <p className="text-[14px] text-red">{run.error}</p>
        ) : (
          <p className="text-[14px] text-fog">{active ? "" : "The agent printed no report."}</p>
        )}
        {report && long && !active && (
          <button type="button" className="justify-self-start text-[12px] font-semibold text-fog hover:text-bone" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Show less" : "Show the whole report"}
          </button>
        )}
      </div>
    </div>
  );
}

/** How many of a ship command's last lines its turn shows; the whole output is in the log. */
const SHIP_TAIL_LINES = 30;

/** A ship: the owner ran the job's ship command; what it printed (the end) instead of an agent's report. */
function ShipTurn({ run, selected }: { run: Run; selected: boolean }) {
  const now = useNow(1000);
  const active = isActive(run.status);
  const output = (run.summary ?? "").split("\n").slice(-SHIP_TAIL_LINES).join("\n");
  return (
    <div className="grid gap-3">
      <div className="turn-you">
        <div className="turn-label">
          <Rocket aria-hidden className="size-3.5" />
          You · Ship · {relativeTime(run.createdAt, now)}
        </div>
        <p className="font-mono text-[13px] break-all text-bone">{run.instructions}</p>
      </div>
      <div className={`turn-agent ${selected ? "turn-selected" : ""}`} aria-current={selected ? "true" : undefined}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-fog">
          <span className="turn-label">Ship command</span>
          <RunPill run={run} />
          <Link to={`/runs/${run.id}`} className="font-mono hover:text-bone" title="Select this run for its details and log">
            #{run.id}
          </Link>
          {run.startedAt && <span>{duration(run.startedAt, run.finishedAt, now)}</span>}
          {run.baseCommit && <span className="font-mono">{run.baseCommit.slice(0, 12)}</span>}
        </div>
        {run.status === "queued" ? (
          <p className="text-[14px] text-fog">Waiting for a free slot. It starts as soon as another run finishes.</p>
        ) : run.status === "running" ? (
          <p className="text-[14px] text-fog">
            Shipping…{" "}
            {!selected && (
              <Link to={`/runs/${run.id}`} className="text-amber hover:underline">
                Watch the log
              </Link>
            )}
          </p>
        ) : (
          <>
            {run.error && <p className="text-[14px] text-red">{run.error}</p>}
            {output ? (
              <pre className="log-view max-h-80 overflow-auto px-4 py-3 whitespace-pre-wrap text-bone">{output}</pre>
            ) : (
              !active && <p className="text-[14px] text-fog">The ship command printed nothing.</p>
            )}
            {run.status !== "succeeded" && (
              <p className="text-[13px] text-fog">Send a change below and the agent gets this output as context; then ship again.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** A command job's run: what started it, then the end of what its command printed. */
function CommandTurn({ run, selected }: { run: Run; selected: boolean }) {
  const now = useNow(1000);
  const active = isActive(run.status);
  const output = (run.summary ?? "").split("\n").slice(-SHIP_TAIL_LINES).join("\n");
  return (
    <div className="grid gap-3">
      <p className="text-[12px] text-fog">
        {run.retryOf !== null ? `Retry of #${run.retryOf} (attempt ${run.attempt})` : `${STARTED_BY[run.trigger]} · ${relativeTime(run.createdAt, now)}`}
      </p>
      <div className={`turn-agent ${selected ? "turn-selected" : ""}`} aria-current={selected ? "true" : undefined}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-fog">
          <span className="turn-label">Command</span>
          <RunPill run={run} />
          <Link to={`/runs/${run.id}`} className="font-mono hover:text-bone" title="Select this run for its details and log">
            #{run.id}
          </Link>
          {run.startedAt && <span>{duration(run.startedAt, run.finishedAt, now)}</span>}
          {run.exitCode !== null && <span className="font-mono">exit {run.exitCode}</span>}
        </div>
        {run.status === "queued" ? (
          <p className="text-[14px] text-fog">
            {run.notBefore && Date.parse(run.notBefore) > now ? `Retrying at ${dateTime(run.notBefore)}.` : "Waiting for a free slot. It starts as soon as another run finishes."}
          </p>
        ) : run.status === "running" ? (
          <p className="text-[14px] text-fog">
            Running…{" "}
            {!selected && (
              <Link to={`/runs/${run.id}`} className="text-amber hover:underline">
                Watch the log
              </Link>
            )}
          </p>
        ) : (
          <>
            {run.error && <p className="text-[14px] text-red">{run.error}</p>}
            {output ? (
              <pre className="log-view max-h-80 overflow-auto px-4 py-3 whitespace-pre-wrap text-bone">{output}</pre>
            ) : (
              !active && <p className="text-[14px] text-fog">The command printed nothing.</p>
            )}
          </>
        )}
      </div>
    </div>
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
          {APPROVAL_REASONS[run.trigger]}{" "}
          {run.mode === "command" ? (
            <>
              Approving runs <span className="font-mono text-bone">{job?.command ?? "the job's command"}</span>
              {job && (
                <>
                  {" "}
                  in <span className="font-mono text-bone">{job.repoPath}</span>
                </>
              )}
              , as you.
            </>
          ) : (
            <>
          Approving starts {agentLabel(run.agent)}
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
            </>
          )}
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

      {job && run.mode !== "command" && (
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


interface Preset {
  id: string;
  label: string;
  mode: RunMode;
  text: (item: Item) => string;
  when: (item: Item) => boolean;
}

const PRESETS: Preset[] = [
  {
    id: "implement",
    label: "Implement the proposal",
    mode: "change",
    text: () =>
      "Implement the proposal from your report. Keep the change minimal, add or update tests, run the project's checks and commit.",
    when: (item) => item.verdict === "needs_decision",
  },
  {
    id: "risks",
    label: "What are the risks?",
    mode: "ask",
    text: () => "What are the risks or open questions here? Be specific and brief.",
    when: (item) => item.withChanges !== null || item.verdict === "needs_decision",
  },
  {
    id: "explain",
    label: "Explain the changes",
    mode: "ask",
    text: () => "Explain what the changes on this branch do and why, file by file, in plain language.",
    when: (item) => item.withChanges !== null,
  },
  {
    id: "review",
    label: "Address review notes",
    mode: "change",
    text: () => "Address these review notes on the current branch. Keep the existing commits and add new ones:\n- ",
    when: (item) => item.withChanges !== null && !item.withChanges.merged,
  },
  {
    id: "reproduce",
    label: "Try to reproduce again",
    mode: "change",
    text: () =>
      "Try again to reproduce the report. Add logging or a failing test that captures the expected behaviour, and report exactly what you observed.",
    when: (item) => item.verdict === "cant_reproduce",
  },
  {
    id: "retry",
    label: "Diagnose and retry",
    mode: "change",
    text: (item) =>
      `The previous attempt failed${item.latestWork.error ? ` (${item.latestWork.error})` : ""}. Diagnose the cause, fix it and finish the original task.`,
    when: (item) => item.state === "failed",
  },
  {
    id: "reply",
    label: "Shorten the reply",
    mode: "ask",
    text: () =>
      'Rewrite your suggested reply to the reporter in two sentences at most, plain and friendly, without technical detail. Put it under a "Suggested reply" heading.',
    when: (item) => item.runs.some((r) => splitReply(r.summary ?? "").reply !== null),
  },
];

/**
 * The next message to the agent. Ask answers without touching the branch; Make changes adds commits
 * to it. Both continue from the item's newest run.
 */
function Composer({ item, job, busy, onStarted }: { item: Item; job: Job | null; busy: Run | null; onStarted: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // "Implement it" in the Inbox links here with ?followUp=implement: start with that preset, never submit.
  const requested = PRESETS.find((p) => p.id === params.get("followUp"));
  const [text, setText] = useState(() => requested?.text(item) ?? "");
  const [preferred, setPreferred] = useState<RunMode>(requested?.mode ?? "change");
  const [starting, setStarting] = useState<RunMode | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const presets = PRESETS.filter((preset) => preset.when(item)).slice(0, 5);

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

  const applyPreset = (preset: Preset) => {
    const value = preset.text(item);
    setText((current) => (current.trim() ? `${current.trimEnd()}\n${value}` : value));
    setPreferred(preset.mode);
    window.requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  };

  const send = async (mode: RunMode) => {
    if (!text.trim() || busy) return;
    setStarting(mode);
    setError(null);
    try {
      const next = await api.followUp(item.latest.id, text, mode);
      setText("");
      setStarting(null);
      onStarted();
      navigate(`/runs/${next.id}`);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStarting(null);
    }
  };

  const fieldError = error instanceof ApiError ? error.fields.instructions : undefined;
  const remembers = job?.effectiveAgent === "pi";
  const button = (mode: RunMode, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={`btn ${preferred === mode ? "btn-primary" : "btn-ghost"}`}
      disabled={starting !== null || !text.trim() || busy !== null}
      onClick={() => void send(mode)}
    >
      {icon}
      {starting === mode ? "Sending…" : label}
    </button>
  );

  return (
    <section aria-label="Next message" className="grid gap-3 rounded-[12px] border border-steel/30 bg-inkwell/40 p-4">
      <label htmlFor="composer" className="sr-only">
        Message to the agent
      </label>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button key={preset.id} type="button" className="btn btn-ghost btn-sm" onClick={() => applyPreset(preset)}>
              {preset.label}
            </button>
          ))}
        </div>
      )}
      <textarea
        id="composer"
        ref={boxRef}
        aria-invalid={Boolean(fieldError)}
        aria-describedby="composer-hint"
        className="field min-h-[96px] resize-y leading-relaxed"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send(preferred);
          }
        }}
        placeholder="Ask the agent something, or tell it what to change…"
      />
      {fieldError && <p className="text-[12px] text-red">{fieldError}</p>}
      {error && !fieldError && <ErrorNote error={error} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id="composer-hint" className="max-w-[52ch] text-[12px] leading-snug text-fog">
          {busy
            ? `Run #${busy.id} is in progress. You can send the next message when it finishes.`
            : `Ask answers without touching the branch. Make changes adds commits to it. ${
                remembers ? "Pi continues the same conversation." : "The agent gets this item's earlier instructions and report."
              }`}
        </p>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          {button("ask", "Ask", <MessageCircleQuestion aria-hidden className="size-3.5" />)}
          {button("change", "Make changes", <Wrench aria-hidden className="size-3.5" />)}
        </div>
      </div>
    </section>
  );
}

function RunDetails({ run, job }: { run: Run; job: Job | null }) {
  const now = useNow(1000);
  const rows: [string, ReactNode][] = [
    [
      "Trigger",
      run.followUpOf !== null
        ? `${run.mode === "ask" ? "Question" : run.mode === "ship" ? "Ship" : run.mode === "release" ? "Release" : "Change request"} after #${run.followUpOf}`
        : TRIGGER_LABELS[run.trigger],
    ],
    ["Agent", run.mode === "ship" ? "None (ship command)" : run.mode === "command" ? "None (command job)" : agentLabel(run.agent)],
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
  if (job && job.kind === "command") {
    rows.push(["Directory", <span key="dir" className="font-mono text-[12px]">{job.repoPath}</span>]);
    rows.push(["Command", <span key="cmd" className="font-mono text-[12px]">{job.command}</span>]);
  } else if (job) rows.push(["Repository", <span key="repo" className="font-mono text-[12px]">{job.repoPath}</span>]);
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
