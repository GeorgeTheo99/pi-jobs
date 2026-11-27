import { SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ErrorNote } from "@/components/ui";
import { ApiError, api, type Job, type Run } from "@/lib/api";
import type { Item } from "@/lib/items";
import { splitReply } from "@/lib/report";
import { usePoll } from "@/lib/usePoll";

interface Preset {
  id: string;
  label: string;
  text: (item: Item) => string;
  when: (item: Item) => boolean;
}

const PRESETS: Preset[] = [
  {
    id: "implement",
    label: "Implement the proposal",
    text: () =>
      'Implement the proposal from your report. Keep the change minimal, add or update tests, run the project\'s checks and commit. End with "Verdict: implemented" (or why not) and an updated suggested reply to the reporter.',
    when: (item) => item.verdict === "needs_decision",
  },
  {
    id: "risks",
    label: "What are the risks?",
    text: () => "What are the risks or open questions here? Be specific and brief.",
    when: (item) => item.withChanges !== null || item.verdict === "needs_decision",
  },
  {
    id: "explain",
    label: "Explain the changes",
    text: () => "Explain what the changes on this branch do and why, file by file, in plain language.",
    when: (item) => item.withChanges !== null,
  },
  {
    id: "review",
    label: "Address review notes",
    text: () => "Address these review notes on the current branch. Keep the existing commits and add new ones:\n- ",
    when: (item) => item.withChanges !== null && !item.withChanges.merged,
  },
  {
    id: "reproduce",
    label: "Try to reproduce again",
    text: () =>
      "Try again to reproduce the report. Add logging or a failing test that captures the expected behaviour, and report exactly what you observed.",
    when: (item) => item.verdict === "cant_reproduce",
  },
  {
    id: "retry",
    label: "Diagnose and retry",
    text: (item) =>
      `The previous attempt failed${item.latestWork.error ? ` (${item.latestWork.error})` : ""}. Diagnose the cause, fix it and finish the original task.`,
    when: (item) => item.state === "failed",
  },
  {
    id: "update-reply",
    label: "Update the reply",
    text: () =>
      'Write an updated suggested reply to the reporter that says what happened to their report now (fixed, released, or still open), in two or three plain sentences with no promised dates. Put it under a "Suggested reply" heading.',
    when: (item) => item.runs.some((r) => splitReply(r.summary ?? "").reply !== null) && (item.state === "released" || item.state === "partial" || item.state === "review"),
  },
  {
    id: "reply",
    label: "Shorten the reply",
    text: () =>
      'Rewrite your suggested reply to the reporter in two sentences at most, plain and friendly, without technical detail. Put it under a "Suggested reply" heading.',
    when: (item) => item.runs.some((r) => splitReply(r.summary ?? "").reply !== null),
  },
];

/**
 * The next message to the agent, from the item's newest run. The agent decides whether it asks a
 * question (answered without touching the branch) or asks for changes (commits added to it).
 */
export function Composer({ item, job, busy, onStarted }: { item: Item; job: Job | null; busy: Run | null; onStarted: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // "Implement it" in the Inbox links here with ?followUp=implement: start with that preset, never submit.
  const requested = PRESETS.find((p) => p.id === params.get("followUp"));
  const [text, setText] = useState(() => requested?.text(item) ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const presets = PRESETS.filter((preset) => preset.when(item)).slice(0, 5);

  useEffect(() => {
    if (!params.has("followUp")) return;
    const box = boxRef.current;
    if (requested && box) {
      box.scrollIntoView({ block: "center" });
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    setParams({}, { replace: true });
    // Only on arrival: the parameter is removed right away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPreset = (preset: Preset) => {
    const value = preset.text(item);
    setText((current) => (current.trim() ? `${current.trimEnd()}\n${value}` : value));
    window.requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  };

  const send = async () => {
    if (!text.trim() || busy || starting) return;
    setStarting(true);
    setError(null);
    try {
      const next = await api.followUp(item.latest.id, text);
      setText("");
      setStarting(false);
      onStarted();
      navigate(`/runs/${next.id}`);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStarting(false);
    }
  };

  const fieldError = error instanceof ApiError ? error.fields.instructions : undefined;
  // Whether the agent continues one conversation per item (Pi and pi-… launchers), per Settings.
  const { data: settings } = usePoll(api.settings, null);
  const remembers = Boolean(job && settings?.agentInfo.find((agent) => agent.id === job.effectiveAgent)?.sessions);

  return (
    <section aria-label="Next message" className="grid gap-3 rounded-[12px] border border-steel/30 bg-inkwell/40 p-4">
      <label htmlFor="composer" className="sr-only">
        Message to the agent
      </label>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button key={preset.id} type="button" className="btn btn-ghost btn-sm" onClick={() => applyPreset(preset)}>
              {preset.label}
            </button>
          ))}
        </div>
      )}
      <textarea
        id="composer"
        ref={boxRef}
        aria-invalid={Boolean(fieldError)}
        aria-describedby="composer-hint"
        className="field min-h-[96px] resize-y leading-relaxed"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Ask the agent something, or tell it what to change…"
      />
      {fieldError && <p className="text-[12px] text-red">{fieldError}</p>}
      {error && !fieldError && <ErrorNote error={error} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id="composer-hint" className="max-w-[52ch] text-[12px] leading-snug text-fog">
          {busy
            ? `Run #${busy.id} is in progress. You can send the next message when it finishes.`
            : `Ask a question or say what to change: the agent answers, or adds commits to the branch. ${
                remembers ? "It continues the same conversation." : "It gets this item's earlier instructions and report."
              }`}
        </p>
        <button
          type="button"
          className="btn btn-primary w-full sm:w-auto"
          disabled={starting || !text.trim() || busy !== null}
          onClick={() => void send()}
        >
          <SendHorizontal aria-hidden className="size-3.5" />
          {starting ? "Sending…" : "Send"}
        </button>
      </div>
    </section>
  );
}

