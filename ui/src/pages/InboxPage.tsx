import { Inbox, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ItemList, WaitingCard } from "@/components/Items";
import { ErrorNote, PageHeader, Skeleton } from "@/components/ui";
import { api, type Job } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { WAITING_STATES, type Item, type ItemState } from "@/lib/items";
import { useItems } from "@/lib/useItems";
import { useNow } from "@/lib/usePoll";

const RECENT_LIMIT = 20;

export function InboxPage() {
  const { items, jobs, jobList, error, refresh } = useItems();
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<Error | null>(null);
  const [showAll, setShowAll] = useState(false);
  const now = useNow(30_000);

  const watchJobs = jobList?.filter((job) => job.watchCommand && job.enabled) ?? [];
  const lastCheck = watchJobs
    .map((job) => job.watchCheckedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    setCheckNote(null);
    try {
      const results = await api.checkWatches();
      const started = results.reduce((sum, r) => sum + r.started, 0);
      const failed = results.filter((r) => r.error);
      setCheckNote(
        `${started === 0 ? "No new reports" : `${started} new report${started === 1 ? "" : "s"}`}${
          failed.length ? ` · ${failed.length} watch${failed.length === 1 ? "" : "es"} reported a problem` : ""
        }`,
      );
      await refresh();
    } catch (err) {
      setCheckError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setChecking(false);
    }
  };

  const pick = (states: readonly ItemState[]) => items?.filter((item) => states.includes(item.state)) ?? [];
  // Oldest first: the report that has waited longest is next.
  const waiting = [...pick(WAITING_STATES)].sort(
    (a, b) => WAITING_STATES.indexOf(a.state) - WAITING_STATES.indexOf(b.state) || a.latest.id - b.latest.id,
  );
  const running = pick(["running"]);
  const review = pick(["review"]);
  const recent = pick(["failed", "shipped", "merged", "closed"]);

  return (
    <>
      <PageHeader
        title="Inbox"
        meta={
          watchJobs.length > 0
            ? `Reports from ${watchJobs.length} watch${watchJobs.length === 1 ? "" : "es"}${lastCheck ? ` · checked ${relativeTime(lastCheck, now)}` : ""}`
            : "Work from your jobs, grouped by what each run was for."
        }
        actions={
          <>
            <Link to="/runs" className="btn btn-ghost">
              All runs
            </Link>
            {watchJobs.length > 0 && (
              <button type="button" className="btn btn-ghost" disabled={checking} onClick={() => void check()}>
                <RefreshCw aria-hidden className={`size-3.5 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} />
                {checking ? "Checking…" : "Check now"}
              </button>
            )}
          </>
        }
      />
      <div className="grid gap-8">
        <ErrorNote error={checkError ?? error} />
        {checkNote && (
          <p role="status" className="-mt-4 text-[13px] text-fog">
            {checkNote}
          </p>
        )}
        {items === null ? (
          <Skeleton rows={4} />
        ) : items.length === 0 ? (
          <Empty />
        ) : (
          <>
            {waiting.length > 0 ? (
              <Section title="Waiting for you" count={waiting.length}>
                <ul className="grid gap-3">
                  {waiting.map((item) => (
                    <WaitingCard key={item.root.id} item={item} job={jobs.get(item.root.jobId)} onChanged={() => void refresh()} />
                  ))}
                </ul>
              </Section>
            ) : (
              <p className="-mt-2 text-[14px] text-fog">Nothing needs you right now.</p>
            )}
            {running.length > 0 && <ItemSection title="In progress" items={running} jobs={jobs} />}
            {review.length > 0 && <ItemSection title="To review" items={review} jobs={jobs} />}
            {recent.length > 0 && (
              <Section title="Recent">
                <ItemList items={showAll ? recent : recent.slice(0, RECENT_LIMIT)} jobs={jobs} />
                {recent.length > RECENT_LIMIT && !showAll && (
                  <button type="button" className="btn btn-ghost justify-self-start" onClick={() => setShowAll(true)}>
                    Show {recent.length - RECENT_LIMIT} more
                  </button>
                )}
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="section-label">
        {title}
        {count !== undefined && <span className="ml-1.5 text-amber">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function ItemSection({ title, items, jobs }: { title: string; items: Item[]; jobs: Map<number, Job> }) {
  return (
    <Section title={title}>
      <ItemList items={items} jobs={jobs} />
    </Section>
  );
}

function Empty() {
  return (
    <div className="rounded-[12px] border border-dashed border-steel/50 px-6 py-12 text-center">
      <Inbox aria-hidden className="mx-auto size-8 text-fog" />
      <h2 className="mt-3 text-[16px] font-semibold">Nothing in the inbox</h2>
      <p className="mx-auto mt-1.5 max-w-[440px] text-[14px] text-fog">
        Runs from your jobs appear here, grouped by the report or task they were for. A watch adds new reports at its next
        check.
      </p>
      <Link to="/jobs" className="btn btn-ghost mt-5">
        Go to jobs
      </Link>
    </div>
  );
}
