import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatAction } from "@/lib/api";
import { ActionCard } from "./ActionCard";

const action = (overrides: Partial<ChatAction>): ChatAction => ({
  type: "update_job",
  args: { jobId: 3 },
  title: 'Change job #3 "Nightly": checkCommand',
  changes: [{ field: "checkCommand", before: "", after: "npm test" }],
  risky: true,
  basis: "2026-11-24T00:00:00Z",
  status: "proposed",
  result: null,
  error: null,
  ...overrides,
});

test("a proposed risky change shows its exact before and after, and applies or dismisses on a click", () => {
  const onDecide = vi.fn();
  render(<ActionCard action={action({})} busy={false} onDecide={onDecide} />);
  expect(screen.getByText("Review carefully")).toBeTruthy();
  expect(screen.getByText("checkCommand")).toBeTruthy();
  expect(screen.getByText("(none)")).toBeTruthy();
  expect(screen.getByText("npm test")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onDecide.mock.calls).toEqual([["apply"], ["dismiss"]]);
});

test("a decided action shows its outcome and a new token once, without buttons", () => {
  render(
    <ActionCard
      action={action({ type: "create_token", title: 'Create API token "phone"', changes: [], status: "applied", result: 'Created API token "phone"' })}
      secret="pjt_secret_value"
      busy={false}
      onDecide={() => {}}
    />,
  );
  expect(screen.getByText("Applied")).toBeTruthy();
  expect(screen.getByText("pjt_secret_value")).toBeTruthy();
  expect(screen.getByText(/Shown once, and never to the agent/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});

test("a new job's fields show without a before", () => {
  render(
    <ActionCard
      action={action({ type: "create_job", title: 'Create job "Docs"', risky: false, changes: [{ field: "name", before: null, after: "Docs" }, { field: "pushBranch", before: null, after: false }] })}
      busy={false}
      onDecide={() => {}}
    />,
  );
  expect(screen.queryByText("(none)")).toBeNull();
  expect(screen.getByText("false")).toBeTruthy();
  expect(screen.queryByText("Review carefully")).toBeNull();
});
