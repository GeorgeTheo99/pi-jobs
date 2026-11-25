import type { ItemData, ItemState, Run, Verdict } from "./api";
import { summarizePayload } from "./format";

export type { ItemState } from "./api";

/**
 * One piece of work: a run started by a trigger, with its retries, follow-ups and releases. A support
 * report's triage, the run that implements it, and its release are one item. The server groups runs
 * into items and says what each needs next; this adds the runs it points at.
 */
export interface Item {
  id: number;
  root: Run;
  /** Oldest first. */
  runs: Run[];
  /** The newest run. */
  latest: Run;
  /** The newest run that isn't a question: what closing, reopening and releasing act on. */
  latestWork: Run;
  state: ItemState;
  verdict: Verdict;
  /** The newest run that left commits on a branch. */
  withChanges: Run | null;
  replied: boolean;
  /** Approve & release can start now. */
  canRelease: boolean;
  /** Approve & promote can start now. */
  canPromote: boolean;
}

export const ITEM_STATE_LABELS: Record<ItemState, string> = {
  approval: "Needs approval",
  running: "Running",
  decision: "Needs your decision",
  review: "Ready to review",
  staged: "Staged",
  failed: "Failed",
  released: "Released",
  merged: "Merged",
  closed: "Closed",
};

/** Items waiting on the owner: they head the Inbox and count in its badge. */
export const WAITING_STATES: readonly ItemState[] = ["approval", "decision", "review", "staged", "failed"];

export function toItem(data: ItemData): Item {
  const byId = (id: number | null) => (id === null ? null : (data.runs.find((run) => run.id === id) ?? null));
  return {
    id: data.id,
    root: data.runs[0]!,
    runs: data.runs,
    latest: data.runs.at(-1)!,
    latestWork: byId(data.latestWorkId) ?? data.runs.at(-1)!,
    state: data.state,
    verdict: data.verdict,
    withChanges: byId(data.withChangesId),
    replied: data.replied,
    canRelease: data.canRelease,
    canPromote: data.canPromote,
  };
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
