import { CheckCheck, MessagesSquare, Send, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ActionCard } from "@/components/ActionCard";
import { Markdown } from "@/components/Markdown";
import { ErrorNote, PageHeader, Skeleton } from "@/components/ui";
import { AGENT_LABELS, api, type ChatAction, type ChatTurn, type ChatWithTurns } from "@/lib/api";
import { duration, relativeTime } from "@/lib/format";
import { useNow, usePoll, useRefreshOnChange } from "@/lib/usePoll";

const MAX_LOG_CHARS = 200_000;

/** What a chat is about, as a link: a job or an item. */
function About({ jobId, runId }: { jobId: number | null; runId: number | null }) {
  if (runId !== null)
    return (
      <Link to={`/runs/${runId}`} className="chip hover:text-bone">
        About the item of run #{runId}
      </Link>
    );
  if (jobId !== null)
    return (
      <Link to={`/jobs/${jobId}`} className="chip hover:text-bone">
        About job #{jobId}
      </Link>
    );
  return null;
}

/** The message box: Enter with ⌘ or Ctrl sends. */
function Composer({
  busy,
  placeholder,
  onSend,
  autoFocus = false,
}: {
  busy: boolean;
  placeholder: string;
  onSend: (message: string) => Promise<void>;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const message = text.trim();
    if (!message || sending || busy) return;
    setSending(true);
    setError(null);
    try {
      await onSend(message);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  return (
    <section aria-label="Message" className="grid gap-3 rounded-[12px] border border-steel/30 bg-inkwell/40 p-4">
      <label htmlFor="chat-message" className="sr-only">
        Message
      </label>
      <textarea
        id="chat-message"
        autoFocus={autoFocus}
        className="field min-h-[96px] resize-y leading-relaxed"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={placeholder}
      />
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[56ch] text-[12px] leading-snug text-fog">
          {busy
            ? "The agent is replying. You can send the next message when it finishes."
            : "The agent reads anything and proposes changes; nothing changes until you apply a card."}
        </p>
        <button type="button" className="btn btn-primary" disabled={sending || busy || !text.trim()} onClick={() => void send()}>
          <Send aria-hidden className="size-3.5" />
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </section>
  );
}

/** Chats, newest first, and a box to start one (about a job or item when the URL says so). */
export function ChatsPage() {
  const [params] = useSearchParams();
  const jobId = params.get("jobId") ? Number(params.get("jobId")) : undefined;
  const runId = params.get("runId") ? Number(params.get("runId")) : undefined;
  const { data: chats, error, refresh } = usePoll(api.chats, (latest) => (latest?.some((c) => c.busy) ? 3000 : 10_000));
  useRefreshOnChange(refresh);
  const navigate = useNavigate();
  const now = useNow();
  const placeholder =
    runId !== undefined
      ? "Ask about this item, or say what to do with it…"
      : jobId !== undefined
        ? "Ask about this job, or say what to change…"
        : "Set up a job, change one, ask why a run failed, approve what's waiting…";

  return (
    <>
      <PageHeader title="Chat" meta="Manage jobs by asking: the agent proposes, you apply." />
      <div className="mx-auto grid max-w-[880px] gap-8">
        <div className="grid gap-3">
          {(jobId !== undefined || runId !== undefined) && (
            <div className="justify-self-start">
              <About jobId={jobId ?? null} runId={runId ?? null} />
            </div>
          )}
          <Composer
            busy={false}
            autoFocus
            placeholder={placeholder}
            onSend={async (message) => {
              const chat = await api.createChat(message, { jobId, runId });
              navigate(`/chats/${chat.id}`);
            }}
          />
        </div>
        <section aria-label="Chats" className="grid gap-2">
          <h2 className="section-label">Chats</h2>
          <ErrorNote error={error} />
          {!chats ? (
            <Skeleton rows={3} />
          ) : chats.length === 0 ? (
            <p className="text-[14px] text-fog">No chats yet.</p>
          ) : (
            <ul className="grid gap-2">
              {chats.map((chat) => {
                const pending = chat.lastTurn?.actions.filter((a) => a.status === "proposed").length ?? 0;
                return (
                  <li key={chat.id}>
                    <Link
                      to={`/chats/${chat.id}`}
                      className="grid gap-1 rounded-[10px] border border-steel/30 bg-inkwell/40 px-4 py-3 hover:border-steel/60"
                    >
                      <span className="flex items-center gap-2 text-[14px] font-semibold text-bone">
                        <MessagesSquare aria-hidden className="size-3.5 text-fog" />
                        {chat.title}
                      </span>
                      <span className="text-[12px] text-fog">
                        {relativeTime(chat.updatedAt, now)}
                        {chat.busy && " · replying…"}
                        {pending > 0 && ` · ${pending} change${pending === 1 ? "" : "s"} to review`}
                        {chat.jobId !== null && ` · job #${chat.jobId}`}
                        {chat.runId !== null && ` · run #${chat.runId}`}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** A reply being written: the agent's output so far. */
function LiveLog({ chatId, turnId }: { chatId: number; turnId: number }) {
  const [text, setText] = useState("");
  const offsetRef = useRef(0);
  const boxRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      let done = false;
      try {
        const chunk = await api.chatLog(chatId, turnId, offsetRef.current);
        if (stopped) return;
        offsetRef.current = chunk.offset;
        done = chunk.done;
        if (chunk.text) setText((current) => (current + chunk.text).slice(-MAX_LOG_CHARS));
      } catch {
        // Try again on the next tick.
      }
      if (!stopped && !done) timer = window.setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [chatId, turnId]);
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <pre ref={boxRef} className="log-view max-h-60 overflow-auto px-3 py-2 text-[12px] whitespace-pre-wrap break-words text-fog">
      {text}
    </pre>
  );
}

function Turn({
  chat,
  turn,
  secrets,
  deciding,
  onDecide,
}: {
  chat: ChatWithTurns;
  turn: ChatTurn;
  secrets: Record<string, string>;
  deciding: string | null;
  onDecide: (turn: ChatTurn, indexes: number[], decision: "apply" | "dismiss") => void;
}) {
  const now = useNow(1000);
  const running = turn.status === "running";
  const plain = turn.actions
    .map((action, index) => [action, index] as [ChatAction, number])
    .filter(([a]) => a.status === "proposed" && !a.risky);
  return (
    <div className="grid gap-3">
      <div className="turn-you">
        <div className="turn-label">You · {relativeTime(turn.createdAt, now)}</div>
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-bone">{turn.message}</p>
      </div>
      <div className="turn-agent">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-fog">
          <span className="turn-label">{AGENT_LABELS[chat.agent]}</span>
          {turn.status === "failed" && <span className="pill pill-red">Failed</span>}
          {turn.status === "canceled" && <span className="pill pill-muted">Stopped</span>}
          {turn.startedAt && <span>{duration(turn.startedAt, turn.finishedAt, now)}</span>}
        </div>
        {running ? (
          <div className="grid gap-2">
            <p className="text-[14px] text-fog">Thinking… it can take a minute or two while the agent reads.</p>
            <LiveLog chatId={chat.id} turnId={turn.id} />
          </div>
        ) : (
          <>
            {turn.reply && <Markdown text={turn.reply} />}
            {turn.error && <p className="text-[14px] text-red">{turn.error}</p>}
            {!turn.reply && !turn.error && turn.status === "succeeded" && (
              <p className="text-[14px] text-fog">The agent printed no reply.</p>
            )}
          </>
        )}
        {turn.actions.length > 0 && (
          <div className="grid gap-2.5 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="section-label">Proposed changes</h3>
              {plain.length > 1 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={deciding !== null}
                  onClick={() =>
                    onDecide(
                      turn,
                      plain.map(([, index]) => index),
                      "apply",
                    )
                  }
                  title="Applies the ones not marked Review carefully, in order"
                >
                  <CheckCheck aria-hidden className="size-3.5" />
                  Apply all {plain.length}
                </button>
              )}
            </div>
            {turn.actions.map((action, index) => (
              <ActionCard
                key={index}
                action={action}
                secret={secrets[`${turn.id}:${index}`]}
                busy={deciding !== null}
                onDecide={(decision) => onDecide(turn, [index], decision)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One chat: the conversation, its proposed changes as cards, and the next message. */
export function ChatPage() {
  const chatId = Number(useParams().id);
  const {
    data: chat,
    error,
    refresh,
    setData,
  } = usePoll(
    () => api.chat(chatId),
    (latest) => (latest?.busy ? 2000 : 15_000),
    [chatId],
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  // Tokens an action created, by "turn:index": shown once, kept only in this page's memory.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const endRef = useRef<HTMLDivElement>(null);
  const turnCount = chat?.turns.length ?? 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turnCount]);

  if (error && !chat) return <ErrorNote error={error} />;
  if (!chat) return <Skeleton rows={4} />;

  const decide = async (turn: ChatTurn, indexes: number[], decision: "apply" | "dismiss") => {
    setActionError(null);
    try {
      for (const index of indexes) {
        setDeciding(`${turn.id}:${index}`);
        const { action, secret } = await api.decideAction(chat.id, turn.id, index, decision);
        if (secret)
          setSecrets((current) => ({
            ...current,
            [`${turn.id}:${index}`]: secret,
          }));
        setData(
          (current) =>
            current && {
              ...current,
              turns: current.turns.map((t) =>
                t.id === turn.id
                  ? {
                      ...t,
                      actions: t.actions.map((a, i) => (i === index ? action : a)),
                    }
                  : t,
              ),
            },
        );
        if (action.status === "failed") break;
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(null);
      void refresh();
    }
  };

  return (
    <article className="mx-auto grid max-w-[880px] gap-7">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-fog">
          <Link to="/chats" className="hover:text-bone">
            ← Chats
          </Link>
          <About jobId={chat.jobId} runId={chat.runId} />
        </div>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <h1 className="run-title min-w-0 flex-1 break-words">{chat.title}</h1>
          {chat.busy ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void api.cancelChat(chat.id).then(refresh, (err: Error) => setActionError(err.message))}
            >
              <Square aria-hidden className="size-3.5" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (!window.confirm("Delete this chat? Changes you applied stay.")) return;
                void api.deleteChat(chat.id).then(
                  () => navigate("/chats"),
                  (err: Error) => setActionError(err.message),
                );
              }}
            >
              <Trash2 aria-hidden className="size-3.5" />
              Delete
            </button>
          )}
        </div>
      </header>
      <ErrorNote error={actionError} />
      <section aria-label="Conversation" className="grid gap-7">
        {chat.turns.map((turn) => (
          <Turn key={turn.id} chat={chat} turn={turn} secrets={secrets} deciding={deciding} onDecide={(t, i, d) => void decide(t, i, d)} />
        ))}
      </section>
      <Composer
        busy={chat.busy}
        placeholder="Reply, ask a follow-up, or ask for a change…"
        onSend={async (message) => {
          setData(await api.sendChat(chat.id, message));
        }}
      />
      <div ref={endRef} />
    </article>
  );
}
