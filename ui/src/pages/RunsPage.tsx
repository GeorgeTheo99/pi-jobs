import { History } from "lucide-react";
import { useMemo, useState } from "react";
import { RunList } from "@/components/RunList";
import { ErrorNote, PageHeader, Skeleton } from "@/components/ui";
import { api, isActive, type Run } from "@/lib/api";
import { usePoll } from "@/lib/usePoll";

const FILTERS: { id: string; label: string; match: (run: Run) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "active", label: "Active", match: (run) => isActive(run.status) },
  { id: "changes", label: "With changes", match: (run) => (run.commits ?? 0) > 0 },
  { id: "failed", label: "Failed", match: (run) => run.status === "failed" || run.status === "timed_out" },
];

export function RunsPage() {
  const runs = usePoll(() => api.runs(undefined, 200), 3000);
  const jobs = usePoll(api.jobs, 15000);
  const [filter, setFilter] = useState("all");
  const jobNames = useMemo(() => new Map(jobs.data?.map((job) => [job.id, job.name])), [jobs.data]);
  const visible = runs.data?.filter(FILTERS.find((f) => f.id === filter)!.match) ?? null;

  return (
    <>
      <PageHeader
        title="Runs"
        meta="Every run, newest first. Runs with changes leave a branch in their repository."
        actions={
          <div role="radiogroup" aria-label="Filter runs" className="segmented">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="grid gap-3">
        <ErrorNote error={runs.error} />
        {visible === null ? (
          <Skeleton rows={5} />
        ) : visible.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-steel/60 px-6 py-12 text-center">
            <History aria-hidden className="mx-auto size-8 text-fog" />
            <p className="mt-3 text-[14px] text-fog">
              {filter === "all" ? "No runs yet. Start one from a job with Run now." : "No runs match this filter."}
            </p>
          </div>
        ) : (
          <RunList runs={visible} jobNames={jobNames} />
        )}
      </div>
    </>
  );
}
