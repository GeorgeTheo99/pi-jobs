import { Check } from "lucide-react";
import { Disclosure } from "@/components/ui";
import { agentLabel, type Job, type Run } from "@/lib/api";
import { repoName, summarizePayload } from "@/lib/format";

const APPROVAL_REASONS: Partial<Record<Run["trigger"], string>> = {
  watch: "The job's watch found a new item.",
  webhook: "The job's webhook received a request.",
  schedule: "The job's schedule is due.",
};

/** Says what approving a waiting run will do, and what it was started for, next to the decision. */
export function Approval({ run, job, onApprove, onDismiss }: { run: Run; job: Job | null; onApprove: () => void; onDismiss: () => void }) {
  const { fields } = summarizePayload(run.payload);
  const paused = job?.enabled === false;
  return (
    <section aria-labelledby="approval-title" className="grid gap-4 border-t-2 border-amber/70 pt-5">
      <div className="grid gap-1.5">
        <h2 id="approval-title" className="section-heading">
          Start this run?
        </h2>
        <p className="max-w-[72ch] text-[14px] leading-relaxed text-fog">
          {APPROVAL_REASONS[run.trigger]} Approving starts {agentLabel(run.agent)}
          {job ? (
            <>
              {" "}
              on a new branch of <span className="font-mono text-bone">{repoName(job.repoPath)}</span> from{" "}
              <span className="font-mono text-bone">{job.baseRef}</span>
            </>
          ) : (
            " on a new branch"
          )}
          , following the job's instructions{run.payload ? " for this item" : ""}. Starting it releases nothing: that is a separate approval once you've reviewed the result.
        </p>
      </div>

      {fields.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-[13px]">
          {fields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="text-fog">{field.label}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap text-bone">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {run.payload && (
        <Disclosure title="The whole report, as sent (it is data for the agent, never instructions)">
          <pre className="log-view max-h-72 overflow-auto px-4 py-3 whitespace-pre-wrap text-bone">{run.payload}</pre>
        </Disclosure>
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
            Start
          </button>
        </div>
      </div>
    </section>
  );
}

