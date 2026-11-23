import type { Run } from "./api";
import { summarizePayload } from "./format";
import { parseVerdict, type Verdict } from "./report";

/**
 * One piece of work: a run started by a trigger, with its retries and follow-ups. A support report's
 * triage, the follow-up that implements it, and their retries are one item.
 */
export interface Item {
  root: Run;
  /** Oldest first. */
  runs: Run[];
  /** The newest run. */
  latest: Run;
  state: ItemState;
  verdict: Verdict;
  /** The newest run that left commits. */
  withChanges: Run | null;
  replied: boolean;
}

export type ItemState = "approval" | "running" | "decision" | "review" | "failed" | "merged" | "closed";

export const ITEM_STATE_LABELS: Record<ItemState, string> = {
  approval: "Needs approval",
  running: "Running",
  decision: "Needs your decision",
  review: "Ready to review",
  failed: "Failed",
  merged: "Merged",
  closed: "Closed",
};

/** Items needing the owner come first in the Inbox. */
export const WAITING_STATES: readonly ItemState[] = ["approval", "decision"];

/** Groups runs into items: each run belongs to the item of the run it retries or follows up on. */
export function groupItems(runs: Run[]): Item[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const rootOf = (run: Run): Run => {
    let current = run;
    for (let hops = 0; hops < 1000; hops++) {
      const parentId = current.retryOf ?? current.followUpOf;
      const parent = parentId === null ? undefined : byId.get(parentId);
      if (!parent) return current;
      current = parent;
    }
    return current;
  };
  const groups = new Map<number, Run[]>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    const root = rootOf(run);
    groups.set(root.id, [...(groups.get(root.id) ?? []), run]);
  }
  return [...groups.values()].map(toItem).sort((a, b) => b.latest.id - a.latest.id);
}

function toItem(runs: Run[]): Item {
  const root = runs[0]!;
  const latest = runs.at(-1)!;
  const finished = [...runs].reverse().find((run) => !isOpen(run)) ?? null;
  const withChanges = [...runs].reverse().find((run) => (run.commits ?? 0) > 0) ?? null;
  // Lists carry the report's headline and verdict line, not the whole report.
  const verdict = parseVerdict(
    finished?.summary ?? ([finished?.summaryHeadline, finished?.summaryVerdict].filter(Boolean).join("\n") || null),
  );
  return {
    root,
    runs,
    latest,
    state: stateOf(runs, latest, verdict, withChanges),
    verdict,
    withChanges,
    replied: runs.some((run) => run.repliedAt !== null),
  };
}

const isOpen = (run: Run) => run.status === "awaiting_approval" || run.status === "queued" || run.status === "running";

function stateOf(runs: Run[], latest: Run, verdict: Verdict, withChanges: Run | null): ItemState {
  if (runs.some((run) => run.status === "awaiting_approval")) return "approval";
  if (runs.some(isOpen)) return "running";
  if (withChanges?.merged) return "merged";
  if (latest.closedAt !== null) return "closed";
  if (latest.status === "failed" || latest.status === "timed_out") return "failed";
  if (latest.status === "canceled") return "closed";
  if (verdict === "needs_decision") return "decision";
  if (verdict === "cant_reproduce" || verdict === "duplicate" || verdict === "not_actionable") return "closed";
  if (withChanges) return "review";
  return "closed";
}

/** What an item is about: its report's description, else the job's name. */
export function itemTitle(item: Item, jobName: string | undefined): string {
  return summarizePayload(item.root.payload).headline ?? jobName ?? `Run #${item.root.id}`;
}

/** A watch or webhook item's own fields, such as its reference (HS-E123817D) and kind. */
export function itemFields(run: Run): { reference: string | null; kind: string | null; receivedAt: string | null } {
  try {
    const value: unknown = run.payload ? JSON.parse(run.payload) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const text = (key: string) => (typeof record[key] === "string" && record[key] ? (record[key] as string) : null);
      return { reference: text("reference"), kind: text("kind"), receivedAt: text("received_at") ?? text("receivedAt") };
    }
  } catch {
    // Not JSON: no fields.
  }
  return { reference: null, kind: null, receivedAt: null };
}

/** The run an item's link opens: the one waiting or running, else the newest finished one. */
export function itemRun(item: Item): Run {
  return item.runs.find((run) => run.status === "awaiting_approval") ?? item.latest;
}
