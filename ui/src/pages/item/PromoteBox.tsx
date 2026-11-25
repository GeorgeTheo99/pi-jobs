import { AlertTriangle, ArrowUpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorNote } from "@/components/ui";
import { agentLabel, api, type PromotePreview } from "@/lib/api";
import type { Item } from "@/lib/items";
import { ConfirmDialog } from "./ReleaseBox";

/**
 * The promotion of a staged item to production: the exact commit its staging release left, whether the
 * base branch on origin has moved past it, and whether another item has replaced it on staging since.
 * Approve & promote opens a confirmation naming that commit, and is refused if it changes before it starts.
 */
export function PromoteBox({ item, onPromoted }: { item: Item; onPromoted: () => void }) {
  const [preview, setPreview] = useState<PromotePreview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [confirming, setConfirming] = useState(false);
  const again = item.latestWork.stage === "production";

  useEffect(() => {
    let stale = false;
    api.promotePreview(item.latest.id).then(
      (loaded) => !stale && setPreview(loaded),
      (err: unknown) => !stale && setError(err instanceof Error ? err : new Error(String(err))),
    );
    return () => {
      stale = true;
    };
  }, [item.latest.id]);

  const blocker =
    preview?.replaced ??
    (preview && preview.behind > 0 ? `${preview.base} has moved past the staged commit, so it can't go out as a fast-forward: release this item to staging again` : null);
  return (
    <section id="promote" aria-labelledby="promote-title" className="grid scroll-mt-6 gap-3">
      <h2 id="promote-title" className="section-heading">
        Promote
      </h2>
      <ErrorNote error={error} />
      {preview && <PromoteFacts preview={preview} />}
      {blocker && (
        <p className="flex items-start gap-2 text-[13px] leading-snug text-red">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {blocker}.
        </p>
      )}
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-fog">
        {agentLabel(preview?.agent ?? item.latest.agent)} continues this item's conversation and ships exactly the staged commit to
        production by the job's promote instructions. {preview?.verifyCommand ? "Then the promote verify command must pass. " : ""}
        It isn't retried; a failure comes back here.
      </p>
      <div className="sticky-actions flex justify-end">
        <button type="button" className="btn btn-primary" disabled={!preview || blocker !== null} onClick={() => setConfirming(true)}>
          <ArrowUpCircle aria-hidden className="size-3.5" />
          {again ? "Promote again…" : "Approve & promote…"}
        </button>
      </div>
      {confirming && preview && (
        <ConfirmDialog
          title={
            <>
              Promote <span className="font-mono">{preview.head.slice(0, 12)}</span> to production?
            </>
          }
          warning={null}
          instructionsTitle={`What ${agentLabel(preview.agent)} is told to do`}
          instructions={preview.instructions}
          confirmLabel="Promote"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await api.promote(item.latest.id, preview.head);
            setConfirming(false);
            onPromoted();
          }}
        >
          <PromoteFacts preview={preview} />
        </ConfirmDialog>
      )}
    </section>
  );
}

function PromoteFacts({ preview }: { preview: PromotePreview }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 rounded-[12px] border border-steel/30 bg-inkwell/40 px-4 py-3 text-[13px]">
      <dt className="text-fog">Promotes</dt>
      <dd className="min-w-0 break-words text-bone">
        <span className="font-mono">{preview.head.slice(0, 12)}</span>, staged by run #{preview.stagedBy}
      </dd>
      <dt className="text-fog">Base</dt>
      <dd className={`min-w-0 ${preview.behind > 0 ? "text-red" : "text-bone"}`}>
        {preview.behind === 0
          ? `A fast-forward of ${preview.base}`
          : `${preview.base} has ${preview.behind} commit${preview.behind === 1 ? "" : "s"} the staged commit lacks: not a fast-forward`}
      </dd>
    </dl>
  );
}
