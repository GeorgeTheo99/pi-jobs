import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Disclosure } from "@/components/ui";
import { TRIGGER_LABELS, agentLabel, api, type Job, type Run } from "@/lib/api";
import { dateTime, duration } from "@/lib/format";
import { useNow } from "@/lib/usePoll";

const MAX_LOG_CHARS = 2_000_000;

export function RunDetails({ run, job }: { run: Run; job: Job | null }) {
  const now = useNow(1000);
  const rows: [string, ReactNode][] = [
    [
      "Trigger",
      run.followUpOf !== null
        ? `${run.mode === "ask" ? "Question" : run.mode === "ship" || run.mode === "release" ? "Release" : "Change request"} after #${run.followUpOf}`
        : TRIGGER_LABELS[run.trigger],
    ],
    ["Agent", run.mode === "ship" ? "None (release script)" : agentLabel(run.agent)],
    ["Started by", run.requestedBy === "autoRelease" ? "Release automatically" : (run.requestedBy ?? (run.followUpOf === null && run.trigger !== "manual" ? `Its ${TRIGGER_LABELS[run.trigger].toLowerCase()}` : "—"))],
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
  if (job) rows.push(["Repository", <span key="repo" className="font-mono text-[12px]">{job.repoPath}</span>]);
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

export function LogView({ runId, live }: { runId: number; live: boolean }) {
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
