import { Check, ShieldAlert, X } from "lucide-react";
import { CopyButton } from "@/components/ui";
import type { ChatAction } from "@/lib/api";
import { formatValue } from "@/lib/format";

const STATUS: Record<ChatAction["status"], [string, string] | null> = {
  proposed: null,
  applied: ["Applied", "pill-green"],
  failed: ["Failed", "pill-red"],
  dismissed: ["Dismissed", "pill-muted"],
  invalid: ["Can't apply", "pill-red"],
};

/**
 * One proposed change: what it does, the exact before and after of each field it changes, and Apply
 * or Dismiss. Risky ones (commands, pushes, Ship, tokens, deletion) are marked for a careful read.
 */
export function ActionCard({
  action,
  secret,
  busy,
  onDecide,
}: {
  action: ChatAction;
  /** A token the action created, shown once. */
  secret?: string;
  busy: boolean;
  onDecide: (decision: "apply" | "dismiss") => void;
}) {
  const status = STATUS[action.status];
  const isNew = action.changes.every((change) => change.before === null);
  return (
    <div
      className={`grid gap-2.5 rounded-[10px] border px-4 py-3 ${action.risky && action.status === "proposed" ? "border-amber/60 bg-amber/5" : "border-steel/35 bg-inkwell/50"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {action.risky && action.status === "proposed" && (
          <span className="pill pill-amber" title="Runs commands, publishes, ships, deletes or handles tokens: read it in full">
            <ShieldAlert aria-hidden className="size-3" />
            Review carefully
          </span>
        )}
        {status && (
          <span className={`pill ${status[1]}`}>
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {status[0]}
          </span>
        )}
        <span className="text-[14px] font-semibold text-bone">{action.title}</span>
      </div>

      {action.changes.length > 0 && (
        <dl className="grid gap-2 text-[13px]">
          {action.changes.map((change) => (
            <div key={change.field} className="grid gap-1">
              <dt className="font-mono text-[12px] text-fog">{change.field}</dt>
              <dd className="grid gap-1">
                {!isNew && (
                  <pre className="log-view overflow-x-auto px-3 py-1.5 whitespace-pre-wrap break-words text-fog line-through decoration-fog/60">
                    {formatValue(change.before)}
                  </pre>
                )}
                <pre className="log-view overflow-x-auto px-3 py-1.5 whitespace-pre-wrap break-words text-bone">{formatValue(change.after)}</pre>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {action.result && <p className="text-[13px] text-green">{action.result}</p>}
      {action.error && <p className="text-[13px] text-red">{action.error}</p>}
      {secret && (
        <div className="grid gap-1.5 rounded-[8px] border border-amber/50 px-3 py-2">
          <p className="text-[12px] text-fog">Shown once, and never to the agent. Copy it now.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-[13px] break-all text-bone">{secret}</code>
            <CopyButton value={secret} />
          </div>
        </div>
      )}

      {action.status === "proposed" && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onDecide("apply")}>
            <Check aria-hidden className="size-3.5" />
            Apply
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDecide("dismiss")}>
            <X aria-hidden className="size-3.5" />
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
