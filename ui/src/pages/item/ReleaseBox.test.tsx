import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Job, ReleasePreview, Run } from "@/lib/api";
import type { Item } from "@/lib/items";
import { ReleaseBox } from "./ReleaseBox";

const preview: ReleasePreview = {
  head: "a".repeat(40),
  headLabel: "run #4",
  base: "origin/main",
  ahead: 1,
  behind: 2,
  conflicts: false,
  files: 3,
  additions: 10,
  deletions: 2,
  checkCommand: null,
  checkStatus: null,
  kind: "agent",
  agent: "pi-claude",
  instructions: "Release it the way AGENTS.md says.",
  verifyCommand: "curl -f localhost",
};

const release = vi.fn(async () => ({}) as Run);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, releasePreview: vi.fn(async () => preview), release: (...args: unknown[]) => release(...(args as [])) } };
});

const run = { id: 4, mode: "change", status: "succeeded" } as Run;
const item = { id: 4, root: run, runs: [run], latest: run, latestWork: run, state: "review", verdict: "implemented", withChanges: run, replied: false, canRelease: true } as Item;
const job = { id: 1, releaseInstructions: "Release it", shipCommand: null, effectiveAgent: "pi-claude" } as Job;

test("release shows what goes out, warns about an unchecked result, and is pinned to the reviewed commit", async () => {
  const onReleased = vi.fn();
  render(<ReleaseBox item={item} job={job} onReleased={onReleased} />);
  await screen.findByText(/origin\/main has 2 newer commits; merges cleanly/);
  expect(screen.getByText(/No check configured/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Approve & release/ }));
  expect(screen.getByText(/Nothing checked this result/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  await waitFor(() => expect(onReleased).toHaveBeenCalled());
  expect(release).toHaveBeenCalledWith(4, preview.head);
});
