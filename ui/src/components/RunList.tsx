import { GitBranch } from "lucide-react";
import { Link } from "react-router-dom";
import { agentLabel, TRIGGER_LABELS, type Run } from "@/lib/api";
import { duration, relativeTime, summarizePayload } from "@/lib/format";
import { useNow } from "@/lib/usePoll";
import { StatusPill } from "./ui";

/** `compact` drops the branch column for narrow side panels. */
export function RunList({ runs, jobNames, compact = false }: { runs: Run[]; jobNames?: Map<number, string>; compact?: boolean }) {
  const now = useNow(1000);
  return (
    <ul className="divide-y divide-steel/35 overflow-hidden rounded-[14px] border border-steel/40 bg-inkwell/40">
      {runs.map((run) => {
        // What a webhook or watch run is about, so a list of them (or of runs to approve) says more than "Watch".
        const { headline } = summarizePayload(run.payload);
        const titledByTrigger = !jobNames && !headline;
        return (
          <li key={run.id}>
            <Link
              to={`/runs/${run.id}`}
              className={`grid items-center gap-x-4 gap-y-1.5 px-4 py-3 transition-colors duration-150 hover:bg-inkwell/70 ${
                compact
                  ? "grid-cols-[104px_minmax(0,1fr)_auto]"
                  : "sm:grid-cols-[110px_minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:px-5"
              }`}
            >
              <StatusPill status={run.status} />
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold">
                  <span className="font-mono text-fog">#{run.id}</span>{" "}
                  {jobNames ? (jobNames.get(run.jobId) ?? "Deleted job") : (headline ?? TRIGGER_LABELS[run.trigger])}
                </div>
                <div className="truncate text-[12px] text-fog">
                  {!titledByTrigger && `${TRIGGER_LABELS[run.trigger]} · `}
                  {run.mode === "command" ? "Command" : agentLabel(run.agent)} · {relativeTime(run.createdAt, now)}
                  {run.followUpOf !== null && ` · ${run.mode === "ask" ? "question" : run.mode === "ship" ? "ship" : run.mode === "release" ? "release" : "follow-up"} after #${run.followUpOf}`}
                  {run.attempt > 1 && ` · attempt ${run.attempt}`}
                  {compact && (run.commits ?? 0) > 0 && <span className="text-bone"> · +{run.commits}</span>}
                </div>
              </div>
              <div className={`min-w-0 truncate font-mono text-[12px] text-fog ${compact ? "hidden" : ""}`}>
                {run.summaryHeadline && !compact ? (
                  <span className="font-sans text-bone/85" title={run.summaryHeadline}>
                    {run.summaryHeadline}
                  </span>
                ) : run.branch ? (
                  <span className="inline-flex max-w-full items-center gap-1.5" title={run.branch}>
                    <GitBranch aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{run.branch}</span>
                    {run.commits !== null && <span className="shrink-0 text-bone">+{run.commits}</span>}
                  </span>
                ) : run.status === "succeeded" ? (
                  "No changes"
                ) : (
                  (run.error ?? (jobNames && headline ? <span className="font-sans text-bone/85">{headline}</span> : ""))
                )}
              </div>
              <div className="text-[12px] text-fog tabular-nums sm:text-right">
                {duration(run.startedAt, run.finishedAt, now)}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
