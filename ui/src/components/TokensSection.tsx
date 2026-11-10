import { LogOut, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError, api, tokenStore, type ApiToken } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { CopyButton, ErrorNote, Field } from "./ui";

/** This server's base URL as other machines' Pi tools should use it, e.g. https://host/pi-jobs. */
const serverUrl = () => new URL(".", document.baseURI).href.replace(/\/$/, "");

export function TokensSection() {
  const tokens = usePoll(api.tokens, null);
  const session = usePoll(api.session, null);
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: ApiToken; secret: string } | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setFieldError(undefined);
    setError(null);
    try {
      setCreated(await api.createToken(name.trim()));
      setName("");
      await tokens.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fields.name) setFieldError(err.fields.name);
      else setError((err as Error).message);
    }
  };

  const revoke = async (token: ApiToken) => {
    const current = token.id === session.data?.token.id;
    const warning = current ? " This browser uses it and will be signed out." : "";
    if (!window.confirm(`Revoke "${token.name}"? Anything using it loses access.${warning}`)) return;
    try {
      await api.deleteToken(token.id);
      if (current) {
        tokenStore.clear();
        window.location.reload();
        return;
      }
      if (created?.token.id === token.id) setCreated(null);
      await tokens.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const signOut = () => {
    tokenStore.clear();
    window.location.reload();
  };

  const setupCommand = `pi-jobs client-config ${serverUrl()}`;

  return (
    <section className="grid max-w-[760px] gap-4">
      <h2 className="section-label">API tokens</h2>
      <p className="-mt-1 text-[13px] text-fog">
        Every browser and every machine's Pi tools sign in with a token. Anyone holding one can run agents as you on this
        server, so revoke tokens you no longer use.
      </p>
      <ErrorNote error={error ?? tokens.error} />

      {created && (
        <div className="grid gap-2 rounded-[12px] border border-amber/40 bg-amber/5 p-3">
          <p className="text-[13px] text-bone">
            Token <strong>{created.token.name}</strong> created. Copy it now; it won't be shown again.
          </p>
          <div className="flex items-center gap-1">
            <code className="log-view min-w-0 flex-1 truncate rounded-[9px] px-3 py-2.5 text-bone">{created.secret}</code>
            <CopyButton value={created.secret} label="Copy token" />
          </div>
          <p className="text-[13px] text-fog">
            To point another machine's Pi tools here, run this there and paste the token when asked:
          </p>
          <div className="flex items-center gap-1">
            <code className="log-view min-w-0 flex-1 overflow-x-auto rounded-[9px] px-3 py-2.5 whitespace-nowrap text-bone">{setupCommand}</code>
            <CopyButton value={setupCommand} label="Copy setup command" />
          </div>
        </div>
      )}

      {tokens.data && (
        <ul className="divide-y divide-steel/35 overflow-hidden rounded-[14px] border border-steel/40 bg-inkwell/40">
          {tokens.data.map((token) => (
            <li key={token.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold">
                  {token.name}
                  {token.id === session.data?.token.id && <span className="ml-2 text-[12px] font-semibold text-amber">This browser</span>}
                </div>
                <div className="text-[12px] text-fog">
                  Created {relativeTime(token.createdAt)} · {token.lastUsedAt ? `used ${relativeTime(token.lastUsedAt)}` : "never used"}
                </div>
              </div>
              <button type="button" className="icon-btn" title={`Revoke ${token.name}`} aria-label={`Revoke ${token.name}`} onClick={() => void revoke(token)}>
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(e) => void create(e)} className="flex flex-wrap items-start gap-2" noValidate>
        <div className="min-w-[220px] flex-1">
          <Field label="New token name" error={fieldError} hint="For example macbook-pro or iphone.">
            {(p) => <input {...p} className="field" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="off" />}
          </Field>
        </div>
        <button type="submit" className="btn btn-ghost mt-[26px]" disabled={!name.trim()}>
          <Plus aria-hidden className="size-4" />
          Create token
        </button>
      </form>

      <div>
        <button type="button" className="btn btn-ghost" onClick={signOut}>
          <LogOut aria-hidden className="size-4" />
          Sign out of this browser
        </button>
      </div>
    </section>
  );
}
