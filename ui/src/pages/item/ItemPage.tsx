import { MessagesSquare, Rocket, Square } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Changes } from "@/components/Changes";
import { ItemPill } from "@/components/Items";
import { Disclosure, ErrorNote, Skeleton } from "@/components/ui";
import { agentLabel, api, isActive, type Job } from "@/lib/api";
import { repoName } from "@/lib/format";
import { itemFields, itemTitle, toItem, type Item } from "@/lib/items";
import { splitReply } from "@/lib/report";
import { usePoll, useRefreshOnChange } from "@/lib/usePoll";
import { Approval } from "./Approval";
import { Composer } from "./Composer";
import { Turn } from "./Conversation";
import { ReleaseBox } from "./ReleaseBox";
import { Reply } from "./Reply";
import { LogView, RunDetails } from "./RunDetails";

/**
 * An item's page, like a pull request: the conversation of its runs (what started it, the owner's
 * questions and change requests, the agent's reports), its changes, the release, and a composer for
 * the next message. The run in the URL is the selected one, whose details and log are at the bottom.
 */
export function ItemPage() {
  const runId = Number(useParams().id);
  const poll = usePoll(
    () => api.item(runId),
    (latest) => (latest?.runs.some((r) => isActive(r.status)) ? 2000 : 8000),
    [runId],
  );
  useRefreshOnChange(poll.refresh);
  const item = useMemo(() => (poll.data ? toItem(poll.data) : null), [poll.data]);
  const run = item?.runs.find((r) => r.id === runId) ?? null;
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
      await poll.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  if (poll.error && !run) return <ErrorNote error={poll.error} />;
  if (!run || !item) return <Skeleton rows={4} />;

  const activeRun = item.runs.find((r) => isActive(r.status) && r.status !== "awaiting_approval") ?? null;
  const waiting = item.runs.find((r) => r.status === "awaiting_approval") ?? null;
  const itemFinished = !item.runs.some((r) => isActive(r.status));
  let replyIndex = -1;
  item.runs.forEach((r, index) => {
    if (!isActive(r.status) && splitReply(r.summary ?? "").reply !== null) replyIndex = index;
  });
  const replyRun = replyIndex === -1 ? null : item.runs[replyIndex]!;
  const reply = replyRun ? splitReply(replyRun.summary ?? "").reply : null;
  // A reply written before later changes or a release may no longer say what happened.
  const replyStale = replyRun !== null && item.runs.slice(replyIndex + 1).some((r) => r.mode !== "ask" && r.status === "succeeded");
  const selectedActive = isActive(run.status);
  const selectedSilent = (run.status === "failed" || run.status === "timed_out") && !run.summary;

  return (
    <article className="grid max-w-[880px] gap-8">
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
            {item.canRelease && (
              <a href="#release" className="btn btn-ghost">
                <Rocket aria-hidden className="size-3.5" />
                Release…
              </a>
            )}
            <Link to={`/chats?runId=${item.latest.id}`} className="btn btn-ghost">
              <MessagesSquare aria-hidden className="size-3.5" />
              Chat about it
            </Link>
            {itemFinished && item.state !== "merged" && item.state !== "released" && (
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
          runId={replyRun.id}
          stale={replyStale}
          replied={item.replied}
          onChange={(value) =>
            void act(async () => {
              if (value) await api.markReplied(replyRun.id, true);
              else await Promise.all(item.runs.filter((r) => r.repliedAt).map((r) => api.markReplied(r.id, false)));
            })
          }
        />
      )}

      {item.withChanges && itemFinished && (
        <Changes key={`changes-${item.withChanges.id}`} run={item.withChanges} job={job} wholeBranch shipped={item.state === "released" || item.state === "merged"} />
      )}

      {item.canRelease && job && <ReleaseBox key={`release-${item.latest.id}`} item={item} job={job} onReleased={() => void poll.refresh()} />}

      {!waiting && job?.kind !== "command" && run.mode !== "command" && (
        <Composer
          key={`composer-${item.root.id}`}
          item={item}
          job={job}
          busy={activeRun}
          onStarted={() => void poll.refresh()}
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

function ItemHeader({ item, job, actions }: { item: Item; job: Job | null; actions: ReactNode }) {
  const { reference, kind } = itemFields(item.root);
  // The agents that actually ran its runs (a release script runs none), not the job's current one.
  const agents = [...new Set(item.runs.filter((r) => r.mode !== "ship" && r.status !== "awaiting_approval").map((r) => r.agent))];
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
            {job?.kind === "command" ? (
              ` · Command in ${repoName(job.repoPath)}`
            ) : (
              <>
                {agents.length > 0 && ` · ${agents.map(agentLabel).join(", ")}`}
                {job && ` on ${repoName(job.repoPath)}`}
              </>
            )}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
    </header>
  );
}

