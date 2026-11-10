import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Run } from "@/lib/api";
import { RunList } from "./RunList";

const base: Run = {
  id: 7,
  jobId: 1,
  trigger: "webhook",
  status: "succeeded",
  agent: "pi",
  payload: null,
  attempt: 1,
  retryOf: null,
  notBefore: null,
  branch: "pi-jobs/gateway-models/run-7",
  worktree: null,
  baseCommit: "abc",
  headCommit: "def",
  commits: 2,
  exitCode: 0,
  checkStatus: null,
  pushedTo: null,
  error: null,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
};

test("shows status, job name, branch and links to the run", () => {
  render(
    <MemoryRouter>
      <RunList
        runs={[base, { ...base, id: 8, status: "failed", branch: null, commits: null, error: "Agent exited 1" }]}
        jobNames={new Map([[1, "Gateway models"]])}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("Succeeded")).toBeTruthy();
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(screen.getAllByText("Gateway models")).toHaveLength(2);
  expect(screen.getByText("pi-jobs/gateway-models/run-7")).toBeTruthy();
  expect(screen.getByText("+2")).toBeTruthy();
  expect(screen.getByText("Agent exited 1")).toBeTruthy();
  expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/runs/7", "/runs/8"]);
});
