import { Check, ChevronRight, CornerDownRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ErrorNote } from "@/components/ui";
import { agentLabel, api, isReleaseMode, type Job } from "@/lib/api";
import { relativeTime, repoName } from "@/lib/format";
import { ITEM_STATE_LABELS, itemFields, itemRun, itemTitle, type Item, type ItemState } from "@/lib/items";
import { VERDICT_LABELS } from "@/lib/report";
import { useNow } from "@/lib/usePoll";

const PILL_CLASSES: Record<ItemState, string> = {
  approval: "pill-amber",
  running: "pill-amber pill-solid",
  decision: "pill-amber",
  review: "pill-green",
  failed: "pill-red",
  released: "pill-violet",
  merged: "pill-violet",
  closed: "pill-muted",
};

/** An item's state ("Ready to review", "Released"), with what its report concluded as a chip beside it. */
export function ItemPill({ item }: { item: Item }) {
  const failedRelease = item.state === "failed" && isReleaseMode(item.latestWork.mode);
  const verdict = (item.state === "review" || item.state === "closed") && item.verdict !== "unknown" ? VERDICT_LABELS[item.verdict] : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={`pill ${PILL_CLASSES[item.state]}`}>
        {item.state === "running" ? (
          <LoaderCircle aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
        ) : (
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
        )}
        {failedRelease ? "Release failed" : ITEM_STATE_LABELS[item.state]}
      </span>
      {verdict && <span className="chip">{verdict}</span>}
    </span>
  );
}

function ItemMeta({ item, job, now }: { item: Item; job: Job | undefined; now: number }) {
  const { reference } = itemFields(item.root);
  const changes = item.withChanges?.commits ?? 0;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fog">
      {reference && <span className="chip chip-mono">{reference}</span>}
      <span className="truncate">{job?.name ?? "Deleted job"}</span>
      <span aria-hidden>·</span>
      <span>{relativeTime(item.latest.createdAt, now)}</span>
      {item.runs.length > 1 && (
        <>
          <span aria-hidden>·</span>
          <span>{item.runs.length} runs</span>
        </>
      )}
      {changes > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>
            {changes} commit{changes === 1 ? "" : "s"}
          </span>
        </>
      )}
      {item.replied && (
        <>
          <span aria-hidden>·</span>
          <span>Replied</span>
        </>
      )}
    </span>
  );
}

/** A compact, linked row for an item. */
export function ItemRow({ item, job }: { item: Item; job: Job | undefined }) {
  const now = useNow(30_000);
  return (
    <li>
      <Link
        to={`/runs/${itemRun(item).id}`}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors duration-150 hover:bg-inkwell/70 sm:grid-cols-[210px_minmax(0,1fr)_auto] sm:px-5"
      >
        <span className="col-span-2 sm:col-span-1">
          <ItemPill item={item} />
        </span>
        <span className="grid min-w-0 gap-1">
          <span className="line-clamp-2 text-[14px] leading-snug font-semibold text-bone sm:truncate">{itemTitle(item, job?.name)}</span>
          <ItemMeta item={item} job={job} now={now} />
        </span>
        <ChevronRight aria-hidden className="size-4 text-fog" />
      </Link>
    </li>
  );
}

export function ItemList({ items, jobs }: { items: Item[]; jobs: Map<number, Job> }) {
  return (
    <ul className="divide-y divide-steel/30 overflow-hidden rounded-[12px] border border-steel/30 bg-inkwell/30">
      {items.map((item) => (
        <ItemRow key={item.root.id} item={item} job={jobs.get(item.root.jobId)} />
      ))}
    </ul>
  );
}

/** What a waiting card says it needs, by the item's state. */
const WAITING_NOTES: Partial<Record<ItemState, string>> = {
  decision: "A proposal: implement it, ask about it, or close it",
  review: "Changes on a branch: review them, then release",
  failed: "It failed: see what happened, then fix or retry it",
};

/** A card for an item waiting on the owner, with the decision's buttons on it. */
export function WaitingCard({ item, job, onChanged }: { item: Item; job: Job | undefined; onChanged: () => void }) {
  const now = useNow(30_000);
  const [busy, setBusy] = useState<"approve" | "dismiss" | "close" | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const run = itemRun(item);
  const act = async (kind: "approve" | "dismiss" | "close", action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(null);
    }
  };
  const { kind } = itemFields(item.root);
  const paused = job?.enabled === false;
  const failed = item.state === "failed";
  const failedRelease = failed && isReleaseMode(item.latestWork.mode);
  const detail = failed ? (item.latestWork.error ?? run.summaryHeadline) : item.state === "approval" ? null : run.summaryHeadline;
  return (
    <li aria-busy={busy !== null} className={`grid gap-3 rounded-[12px] border p-4 ${failed ? "border-red/50 bg-red/5" : "border-steel/30 bg-inkwell/40"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ItemPill item={item} />
        {kind && <span className="chip capitalize">{kind}</span>}
      </div>
      <Link to={`/runs/${run.id}`} className="group grid gap-1.5">
        <span className="line-clamp-3 text-[15px] leading-snug font-semibold text-bone group-hover:text-amber">{itemTitle(item, job?.name)}</span>
        <ItemMeta item={item} job={job} now={now} />
      </Link>
      {detail && <p className={`line-clamp-2 text-[13px] leading-relaxed ${failed ? "text-red" : "text-fog"}`}>{detail}</p>}
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-fog">
          {item.state === "approval"
            ? paused
              ? "The job is paused. Resume it to start."
              : `${agentLabel(run.agent)} on ${job ? repoName(job.repoPath) : "the repository"}`
            : failedRelease
              ? "The release didn't finish: check what it did before releasing again"
              : WAITING_NOTES[item.state]}
        </span>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          {item.state === "approval" ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void act("dismiss", () => api.cancelRun(run.id))}>
                {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || paused}
                onClick={() => void act("approve", () => api.approveRun(run.id))}
              >
                <Check aria-hidden className="size-3.5" />
                {busy === "approve" ? "Starting…" : "Start"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() => void act("close", () => api.markClosed(item.latestWork.id, true))}
              >
                {busy === "close" ? "Closing…" : "Close"}
              </button>
              {item.state === "decision" ? (
                <Link to={`/runs/${run.id}?followUp=implement`} className="btn btn-primary">
                  <CornerDownRight aria-hidden className="size-3.5" />
                  Implement it
                </Link>
              ) : (
                <Link to={`/runs/${run.id}`} className="btn btn-primary">
                  {failed ? "See what failed" : "Review"}
                </Link>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}
