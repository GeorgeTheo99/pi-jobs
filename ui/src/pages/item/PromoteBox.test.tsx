import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PromotePreview, Run } from "@/lib/api";
import type { Item } from "@/lib/items";
import { PromoteBox } from "./PromoteBox";

const preview: PromotePreview = {
  head: "b".repeat(40),
  stagedBy: 5,
  base: "origin/main",
  behind: 0,
  replaced: null,
  agent: "pi-claude",
  instructions: "Push the staged commit to main.",
  verifyCommand: "curl -f localhost",
};

const promotePreview = vi.fn(async () => preview);
const promote = vi.fn(async () => ({}) as Run);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, promotePreview: (...args: unknown[]) => promotePreview(...(args as [])), promote: (...args: unknown[]) => promote(...(args as [])) },
  };
});

const staged = { id: 5, mode: "release", stage: "staging", status: "succeeded", agent: "pi-claude" } as Run;
const item = { id: 4, root: staged, runs: [staged], latest: staged, latestWork: staged, state: "staged", canPromote: true } as Item;

test("promote names the staged commit and is pinned to it", async () => {
  const onPromoted = vi.fn();
  render(<PromoteBox item={item} onPromoted={onPromoted} />);
  await screen.findByText(/A fast-forward of origin\/main/);
  fireEvent.click(screen.getByRole("button", { name: /Approve & promote/ }));
  fireEvent.click(screen.getByRole("button", { name: "Promote" }));
  await waitFor(() => expect(onPromoted).toHaveBeenCalled());
  expect(promote).toHaveBeenCalledWith(5, preview.head);
});

test("promote is ruled out when the base branch moved past the staged commit", async () => {
  promotePreview.mockResolvedValueOnce({ ...preview, behind: 2 });
  render(<PromoteBox item={item} onPromoted={() => undefined} />);
  await screen.findByText(/has 2 commits the staged commit lacks/);
  expect((screen.getByRole("button", { name: /Approve & promote/ }) as HTMLButtonElement).disabled).toBe(true);
});

test("promote is ruled out once another item replaced this one on staging", async () => {
  promotePreview.mockResolvedValueOnce({ ...preview, replaced: "Staging has since had run #9 of item #8: release this item to staging again before promoting it" });
  render(<PromoteBox item={item} onPromoted={() => undefined} />);
  await screen.findByText(/Staging has since had run #9/);
  expect((screen.getByRole("button", { name: /Approve & promote/ }) as HTMLButtonElement).disabled).toBe(true);
});
