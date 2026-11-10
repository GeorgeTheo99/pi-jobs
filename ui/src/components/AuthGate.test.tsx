import { act, fireEvent, render, screen } from "@testing-library/react";
import { AUTH_REQUIRED_EVENT, tokenStore } from "@/lib/api";
import { AuthGate } from "./AuthGate";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

// Node's own (file-less) localStorage global shadows jsdom's under vitest, so use an in-memory one.
beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  });
});

afterEach(() => vi.unstubAllGlobals());

test("asks for a token when none is stored, and checks it before saving", async () => {
  const fetchMock = respond(200, { token: { id: 1, name: "laptop" } });
  vi.stubGlobal("fetch", fetchMock);
  render(<AuthGate>app</AuthGate>);
  expect(screen.queryByText("app")).toBeNull();
  fireEvent.change(screen.getByLabelText("API token"), { target: { value: "pjt_good" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  expect(await screen.findByText("app")).toBeTruthy();
  expect(tokenStore.get()).toBe("pjt_good");
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer pjt_good");
});

test("a rejected token is not saved", async () => {
  vi.stubGlobal("fetch", respond(401, { error: "Sign in with an API token" }));
  render(<AuthGate>app</AuthGate>);
  fireEvent.change(screen.getByLabelText("API token"), { target: { value: "pjt_bad" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
  expect(await screen.findByText("That token isn't valid.")).toBeTruthy();
  expect(tokenStore.get()).toBeNull();
});

test("a stored token shows the app until the server rejects it", async () => {
  tokenStore.set("pjt_good");
  vi.stubGlobal("fetch", respond(200, { token: { id: 1, name: "laptop" } }));
  render(<AuthGate>app</AuthGate>);
  expect(await screen.findByText("app")).toBeTruthy();
  act(() => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
});
