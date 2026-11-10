import { CalendarClock, Play, Plus, Webhook } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AgentBadge, ErrorNote, PageHeader, Skeleton, StatusPill, Switch } from "@/components/ui";
import { api, jobToDraft, type Job } from "@/lib/api";
import { describeSchedule, relativeTime, repoName } from "@/lib/format";
import { useNow, usePoll } from "@/lib/usePoll";

export function JobsPage() {
  const { data: jobs, error, refresh, setData } = usePoll(api.jobs, 5000);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();
  const now = useNow();

  const runNow = async (job: Job) => {
    setActionError(null);
    try {
      const run = await api.runJob(job.id);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const setEnabled = async (job: Job, enabled: boolean) => {
    setActionError(null);
    setData((current) => current?.map((j) => (j.id === job.id ? { ...j, enabled } : j)) ?? null);
    try {
      await api.updateJob(job.id, { ...jobToDraft(job), enabled });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    await refresh();
  };

  return (
    <>
      <PageHeader
        title="Jobs"
        meta="Agents that work on your repos on a schedule, from a webhook, or when you run them."
        actions={
          <Link to="/jobs/new" className="btn btn-primary">
            <Plus aria-hidden className="size-4" />
            New job
          </Link>
        }
      />
      <div className="grid gap-3">
        <ErrorNote error={actionError ?? error} />
        {jobs === null ? (
          <Skeleton />
        ) : jobs.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="divide-y divide-steel/35 overflow-hidden rounded-[14px] border border-steel/40 bg-inkwell/40">
            {jobs.map((job) => (
              <li
                key={job.id}
                className={`grid items-center gap-x-5 gap-y-2 px-4 py-3.5 transition-colors duration-150 hover:bg-inkwell/70 sm:px-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_auto_minmax(0,1fr)_auto] ${
                  job.enabled ? "" : "opacity-60"
                }`}
              >
                <div className="min-w-0">
                  <Link to={`/jobs/${job.id}`} className="block truncate text-[15px] font-semibold hover:text-amber">
                    {job.name}
                  </Link>
                  <div className="truncate font-mono text-[12px] text-fog" title={job.repoPath}>
                    {repoName(job.repoPath)} · {job.baseRef}
                  </div>
                </div>

                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <span className="inline-flex items-center gap-1.5 text-bone">
                    <CalendarClock aria-hidden className="size-3.5 text-fog" />
                    {describeSchedule(job.schedule)}
                  </span>
                  {job.nextRunAt && <span className="text-fog">next {relativeTime(job.nextRunAt, now)}</span>}
                  {job.webhookToken && (
                    <span className="inline-flex items-center gap-1 text-fog" title="Webhook trigger on">
                      <Webhook aria-hidden className="size-3.5" />
                      Webhook
                    </span>
                  )}
                </div>

                <div>
                  <AgentBadge agent={job.effectiveAgent} inherited={job.agent === null} />
                </div>

                <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
                  {job.lastRun ? (
                    <Link to={`/runs/${job.lastRun.id}`} className="flex items-center gap-2.5 hover:text-bone">
                      <StatusPill status={job.lastRun.status} />
                      <span className="truncate text-fog">{relativeTime(job.lastRun.createdAt, now)}</span>
                    </Link>
                  ) : (
                    <span className="text-fog">Never run</span>
                  )}
                </div>

                <div className="flex items-center gap-3 lg:justify-end">
                  <button type="button" className="btn btn-ghost" onClick={() => void runNow(job)}>
                    <Play aria-hidden className="size-3.5" />
                    Run now
                  </button>
                  <Switch
                    checked={job.enabled}
                    label={job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`}
                    onChange={(value) => void setEnabled(job, value)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <div className="rounded-[14px] border border-dashed border-steel/60 px-6 py-12 text-center">
      <CalendarClock aria-hidden className="mx-auto size-8 text-fog" />
      <h2 className="mt-3 text-[16px] font-semibold">No jobs yet</h2>
      <p className="mx-auto mt-1.5 max-w-[460px] text-[14px] text-fog">
        A job points an agent at a repository with instructions. Each run works in its own git worktree and leaves its
        changes on a branch for you to review.
      </p>
      <Link to="/jobs/new" className="btn btn-primary mt-5">
        <Plus aria-hidden className="size-4" />
        Create the first job
      </Link>
    </div>
  );
}
