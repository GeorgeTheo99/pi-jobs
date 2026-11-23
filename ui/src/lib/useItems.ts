import { useMemo } from "react";
import { api, type Job } from "./api";
import { groupItems, type Item } from "./items";
import { usePoll, useRefreshOnChange } from "./usePoll";

/** Polls runs and jobs and groups the runs into items, newest first. */
export function useItems(interval = 4000, jobId?: number) {
  const runs = usePoll(() => api.runs(jobId, 200), interval, [jobId]);
  const jobs = usePoll(api.jobs, 15_000);
  useRefreshOnChange(runs.refresh);
  useRefreshOnChange(jobs.refresh);
  const items = useMemo<Item[] | null>(() => (runs.data ? groupItems(runs.data) : null), [runs.data]);
  const jobsById = useMemo(() => new Map<number, Job>(jobs.data?.map((job) => [job.id, job])), [jobs.data]);
  // Items wait for jobs too, so rows never flash "Deleted job" or a bare run number while jobs load.
  return {
    items: jobs.data ? items : null,
    jobs: jobsById,
    jobList: jobs.data,
    error: runs.error ?? jobs.error,
    refresh: runs.refresh,
  };
}
