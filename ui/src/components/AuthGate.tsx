import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AUTH_REQUIRED_EVENT, ApiError, api, tokenStore } from "@/lib/api";

type State = "checking" | "signed-in" | "signed-out";

/** Shows the app only with a working API token; otherwise asks for one. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() => (tokenStore.get() ? "checking" : "signed-out"));

  useEffect(() => {
    if (state === "checking") {
      api.session().then(
        () => setState("signed-in"),
        // Only a rejected token signs out; network errors leave the pages to report themselves.
        (error) => setState(error instanceof ApiError && error.status === 401 ? "signed-out" : "signed-in"),
      );
    }
  }, [state]);

  useEffect(() => {
    const onAuthRequired = () => setState("signed-out");
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  if (state === "checking") return null;
  if (state === "signed-out") return <SignIn onSignedIn={() => setState("signed-in")} />;
  return children;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.session(token.trim());
      tokenStore.set(token.trim());
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "That token isn't valid." : String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form onSubmit={(e) => void submit(e)} className="grid w-full max-w-[420px] gap-5 rounded-[16px] border border-steel/50 bg-inkwell/50 p-6">
        <div className="flex items-center gap-2.5">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-7" />
          <span className="text-[15px] font-extrabold tracking-[-0.02em]">pi-jobs</span>
        </div>
        <div>
          <h1 className="text-[20px] font-bold tracking-[-0.02em]">Sign in</h1>
          <p className="mt-1 text-[13px] text-fog">
            Paste an API token. Create one on the server with <code className="font-mono text-bone">pi-jobs token create &lt;name&gt;</code>, or
            under Settings → API tokens on a device that's already signed in.
          </p>
        </div>
        <label className="grid gap-1.5">
          <span className="text-[13px] font-semibold">API token</span>
          <input
            type="password"
            className="field font-mono text-[13px]"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            autoFocus
            aria-invalid={Boolean(error)}
          />
        </label>
        {error && <p className="text-[13px] text-red">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>
          <KeyRound aria-hidden className="size-4" />
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
