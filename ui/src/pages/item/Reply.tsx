import { CopyButton, Section, Switch } from "@/components/ui";

/** The agent's suggested reply to the reporter, from the run that wrote it, and whether it was sent. */
export function Reply({
  reply,
  runId,
  stale,
  replied,
  onChange,
}: {
  reply: string;
  runId: number;
  /** Later work changed the item, so the reply may not say what happened. */
  stale: boolean;
  replied: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Section title="Suggested reply to the reporter" aside={<CopyButton value={reply} label="Copy reply" />}>
      <p className="-mt-1 text-[12px] text-fog">
        From run #{runId}
        {stale && (
          <span className="text-amber">
            {" "}
            · written before later work on this item: ask the agent for an updated reply before sending it
          </span>
        )}
      </p>
      <blockquote className="max-w-[72ch] border-l-2 border-steel/60 pl-4 text-[15px] leading-relaxed whitespace-pre-wrap text-bone">
        {reply}
      </blockquote>
      <div className="flex items-center justify-between gap-4 rounded-[12px] border border-steel/30 px-4 py-3">
        <div>
          <div className="text-[13px] font-semibold">Replied</div>
          <p className="text-[12px] text-fog">pi-jobs doesn't send replies. Copy the text, send it yourself, then mark it replied.</p>
        </div>
        <Switch checked={replied} onChange={onChange} label="Replied to the reporter" />
      </div>
    </Section>
  );
}
