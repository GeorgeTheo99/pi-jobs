import { AlertTriangle, Rocket, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Disclosure, ErrorNote } from "@/components/ui";
import { agentLabel, api, isReleaseMode, type Job, type ReleasePreview } from "@/lib/api";
import type { Item } from "@/lib/items";

/**
 * The release, after the changes it releases: what goes out against the base branch on origin, the
 * check, and how the job releases. Approve & release opens a confirmation naming the exact commit, and
 * the release is refused if the item moves on before it starts.
 */
export function ReleaseBox({ item, job, onReleased }: { item: Item; job: Job; onReleased: () => void }) {
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [confirming, setConfirming] = useState(false);
  const again = isReleaseMode(item.latestWork.mode);
  const primary = item.state === "review" || item.state === "failed";

  useEffect(() => {
    let stale = false;
    api.releasePreview(item.latest.id).then(
      (loaded) => !stale && setPreview(loaded),
      (err: unknown) => !stale && setError(err instanceof Error ? err : new Error(String(err))),
    );
    return () => {
      stale = true;
    };
  }, [item.latest.id]);

  return (
    <section id="release" aria-labelledby="release-title" className="grid scroll-mt-6 gap-3">
      <h2 id="release-title" className="section-heading">
        Release
      </h2>
      <ErrorNote error={error} />
      {preview && <PreviewFacts preview={preview} />}
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-fog">
        {job.releaseInstructions
          ? `${agentLabel(preview?.agent ?? job.effectiveAgent)} continues this item's conversation and releases it by the job's release instructions. In that run only it may merge, push, deploy and publish.`
          : "The job's release script runs on this item's result."}{" "}
        {preview?.verifyCommand ? "Then the verify command must pass. " : ""}It isn't retried; a failure comes back here.
      </p>
      <div className="sticky-actions flex justify-end">
        <button
          type="button"
          className={`btn ${primary ? "btn-primary" : "btn-ghost"}`}
          disabled={!preview}
          onClick={() => setConfirming(true)}
        >
          <Rocket aria-hidden className="size-3.5" />
          {again ? "Release again…" : "Approve & release…"}
        </button>
      </div>
      {confirming && preview && (
        <ConfirmRelease
          preview={preview}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await api.release(item.latest.id, preview.head);
            setConfirming(false);
            onReleased();
          }}
        />
      )}
    </section>
  );
}

function PreviewFacts({ preview }: { preview: ReleasePreview }) {
  const check =
    preview.checkStatus === "passed"
      ? { text: "Check passed", tone: "text-green" }
      : preview.checkStatus === "failed"
        ? { text: "Check failed", tone: "text-red" }
        : { text: preview.checkCommand ? "Check didn't run" : "No check configured: the tests are the agent's word", tone: "text-amber" };
  const base =
    preview.behind === 0
      ? `Up to date with ${preview.base}`
      : `${preview.base} has ${preview.behind} newer commit${preview.behind === 1 ? "" : "s"}; ${preview.conflicts ? "it conflicts with them" : "merges cleanly"}`;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 rounded-[12px] border border-steel/30 bg-inkwell/40 px-4 py-3 text-[13px]">
      <dt className="text-fog">Releases</dt>
      <dd className="min-w-0 truncate text-bone">
        <span className="font-mono">{preview.head.slice(0, 12)}</span> ({preview.headLabel}) · {preview.ahead} commit{preview.ahead === 1 ? "" : "s"}, {preview.files}{" "}
        file{preview.files === 1 ? "" : "s"}, <span className="text-green">+{preview.additions}</span> <span className="text-red">−{preview.deletions}</span>
      </dd>
      <dt className="text-fog">Base</dt>
      <dd className={`min-w-0 ${preview.conflicts ? "text-red" : "text-bone"}`}>{base}</dd>
      <dt className="text-fog">Check</dt>
      <dd className={`min-w-0 ${check.tone}`}>{check.text}</dd>
    </dl>
  );
}

/** A modal confirmation with what exactly goes out; Escape or Cancel closes it. */
function ConfirmRelease({ preview, onCancel, onConfirm }: { preview: ReleasePreview; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Modal where the browser supports it (all current ones); open in place otherwise.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => (typeof dialog.close === "function" ? dialog.close() : dialog.removeAttribute("open"));
  }, []);
  const risky = preview.conflicts || preview.checkStatus !== "passed";
  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-release-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(560px,calc(100vw-24px))] rounded-[14px] border border-steel/50 bg-midnight p-0 text-bone backdrop:bg-black/60"
    >
      <div className="grid gap-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 id="confirm-release-title" className="text-[17px] font-bold">
            Release <span className="font-mono">{preview.head.slice(0, 12)}</span>?
          </h2>
          <button type="button" className="icon-btn" aria-label="Cancel" onClick={onCancel}>
            <X className="size-4" />
          </button>
        </div>
        <PreviewFacts preview={preview} />
        {risky && (
          <p className="flex items-start gap-2 text-[13px] leading-snug text-amber">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {preview.conflicts
              ? "It conflicts with the base branch: the release will have to resolve that."
              : "Nothing checked this result: review the changes before releasing."}
          </p>
        )}
        <Disclosure title={preview.kind === "agent" ? `What ${agentLabel(preview.agent ?? "")} is told to do` : "The release script"}>
          <pre className="log-view max-h-60 overflow-auto px-4 py-3 whitespace-pre-wrap text-bone">{preview.instructions}</pre>
        </Disclosure>
        <p className="text-[12px] leading-snug text-fog">
          It runs as you, with your credentials, and may do things that can't be undone. If the item changes before it starts, it is refused.
        </p>
        <ErrorNote error={error} />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting}
            onClick={() => {
              setStarting(true);
              setError(null);
              onConfirm().catch((err: unknown) => {
                setError(err instanceof Error ? err : new Error(String(err)));
                setStarting(false);
              });
            }}
          >
            <Rocket aria-hidden className="size-3.5" />
            {starting ? "Starting…" : "Release"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
