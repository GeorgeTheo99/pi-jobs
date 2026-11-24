import { MessageCircleQuestion, Rocket, Wrench } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Markdown } from "@/components/Markdown";
import { StatusPill } from "@/components/ui";
import { isActive, isReleaseMode, type Run, type Verdict } from "@/lib/api";
import { duration, relativeTime } from "@/lib/format";
import { VERDICT_LABELS, splitReply } from "@/lib/report";
import { useNow } from "@/lib/usePoll";

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
export function RunPill({ run }: { run: Run }) {
  if (run.status !== "succeeded") return <StatusPill status={run.status} />;
  const verdict = run.verdict ?? "unknown";
  const [label, tone] =
    isReleaseMode(run.mode)
      ? ["Released", "pill-violet"]
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

const STARTED_BY: Record<Run["trigger"], string> = {
  watch: "The job's watch found this report",
  webhook: "The job's webhook received this",
  schedule: "The job's schedule started this",
  manual: "Started with Run now",
};

/** One exchange: what the owner asked or asked for (or what started the item), then the agent's reply. */
export function Turn({ run, selected, latest }: { run: Run; selected: boolean; latest: boolean }) {
  const now = useNow(1000);
  const active = isActive(run.status);
  const { report } = splitReply(run.summary ?? "");
  // Short replies show whole; long reports fold unless they are the newest or selected.
  const long = report.length > 280 || report.split("\n").length > 4;
  const [expanded, setExpanded] = useState(selected || latest || !long);
  const ask = run.mode === "ask";
  const release = run.mode === "release";
  if (run.mode === "ship") return <ScriptReleaseTurn run={run} selected={selected} />;
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
            {release ? `Release${releasedBy(run)}` : `You · ${ask ? "Ask" : "Make changes"}`} · {relativeTime(run.createdAt, now)}
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

/** How many of a release script's last lines its turn shows; the whole output is in the log. */
const SHIP_TAIL_LINES = 30;

/** A release by script: the job's release script ran; what it printed (the end) instead of an agent's report. */
function ScriptReleaseTurn({ run, selected }: { run: Run; selected: boolean }) {
  const now = useNow(1000);
  const active = isActive(run.status);
  const output = (run.summary ?? "").split("\n").slice(-SHIP_TAIL_LINES).join("\n");
  return (
    <div className="grid gap-3">
      <div className="turn-you">
        <div className="turn-label">
          <Rocket aria-hidden className="size-3.5" />
          Release{releasedBy(run)} · {relativeTime(run.createdAt, now)}
        </div>
        <p className="font-mono text-[13px] break-all text-bone">{run.instructions}</p>
      </div>
      <div className={`turn-agent ${selected ? "turn-selected" : ""}`} aria-current={selected ? "true" : undefined}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-fog">
          <span className="turn-label">Release script</span>
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
            Releasing…{" "}
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
              !active && <p className="text-[14px] text-fog">The release script printed nothing.</p>
            )}
            {run.status !== "succeeded" && (
              <p className="text-[13px] text-fog">Send a change below and the agent gets this output as context; then release again.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Who started a release: " · automatic", " · by <token name>", or nothing when not recorded. */
function releasedBy(run: Run): string {
  if (run.requestedBy === "autoRelease") return " · automatic";
  return run.requestedBy ? ` · by ${run.requestedBy}` : "";
}
