import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { TokensSection } from "@/components/TokensSection";
import { ErrorNote, Field, PageHeader, Skeleton } from "@/components/ui";
import { ApiError, agentLabel, api, type Settings } from "@/lib/api";
import { usePoll } from "@/lib/usePoll";

export function SettingsPage() {
  const { data, error } = usePoll(api.settings, null);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Skeleton rows={4} />;
  return (
    <div className="grid gap-12">
      <SettingsForm initial={data} />
      <TokensSection />
    </div>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [newId, setNewId] = useState("");
  const [newCommand, setNewCommand] = useState("");

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
  };
  // Built-ins first, then agents added by name; an added one is checked for on the PATH once saved.
  const ids = Object.keys(settings.agents);
  const infoOf = (id: string) => settings.agentInfo.find((a) => a.id === id);
  const setCommand = (id: string, command: string) => update({ agents: { ...settings.agents, [id]: { command } } });
  const removeAgent = (id: string) => {
    const rest = Object.fromEntries(Object.entries(settings.agents).filter(([key]) => key !== id));
    update({ agents: rest });
  };
  const addId = newId.trim();
  const addError = !addId
    ? null
    : !/^[a-z][a-z0-9-]{0,31}$/.test(addId)
      ? "Use lowercase letters, digits and dashes, starting with a letter"
      : Object.hasOwn(settings.agents, addId)
        ? "An agent has that name"
        : null;
  const addAgent = () => {
    if (!addId || addError) return;
    setCommand(addId, newCommand.trim() || `${addId} -p {prompt}`);
    setNewId("");
    setNewCommand("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (addId && addError) return;
    setSaving(true);
    setError(null);
    setFields({});
    try {
      const { defaultAgent, maxConcurrent } = settings;
      // An agent typed into Add but not added yet is saved too, rather than dropped.
      const agents = addId && !addError ? { ...settings.agents, [addId]: { command: newCommand.trim() || `${addId} -p {prompt}` } } : settings.agents;
      setSettings(await api.saveSettings({ defaultAgent, agents, maxConcurrent }));
      setNewId("");
      setNewCommand("");
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" meta="Which agent runs jobs, and how it is started." />
      <form onSubmit={(e) => void submit(e)} className="grid max-w-[760px] gap-8" noValidate>
        <fieldset className="grid gap-3">
          <legend className="section-label mb-3">Default agent</legend>
          <p className="-mt-1 text-[13px] text-fog">Used by every job that doesn't pick its own agent.</p>
          <div role="radiogroup" aria-label="Default agent" className="grid gap-2 sm:grid-cols-3">
            {ids.map((id) => {
              const checked = settings.defaultAgent === id;
              const agent = infoOf(id) ?? { label: agentLabel(id), executable: null, unsaved: true };
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => update({ defaultAgent: id })}
                  className={`grid gap-1 rounded-[12px] border px-4 py-3 text-left transition-colors duration-150 ${
                    checked ? "border-amber/60 bg-amber/10" : "border-steel/50 bg-inkwell/40 hover:bg-channel"
                  }`}
                >
                  <span className={`text-[14px] font-semibold ${checked ? "text-amber" : "text-bone"}`}>{agent.label}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                    {"unsaved" in agent ? (
                      <span className="truncate text-fog">Save to check it</span>
                    ) : (
                      <>
                        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${agent.executable ? "bg-green" : "bg-red"}`} />
                        <span className={`truncate ${agent.executable ? "text-fog" : "text-red"}`} title={agent.executable ?? undefined}>
                          {agent.executable ?? "Not found on the server's PATH"}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="grid gap-4">
          <legend className="section-label mb-3">Commands</legend>
          <p className="-mt-1 text-[13px] text-fog">
            How each agent is started, headless, inside the run's worktree. <code className="font-mono text-bone">{"{prompt}"}</code> becomes one
            argument holding the job's instructions; without it the prompt is added at the end. Agents run as you, with your credentials.
          </p>
          {ids.map((id) => {
            const info = infoOf(id);
            const command = settings.agents[id]!.command;
            return (
              <Field key={id} label={agentLabel(id)} error={fields[`agents.${id}`]}>
                {(p) => (
                  <div className="flex gap-2">
                    <input
                      {...p}
                      className="field font-mono text-[13px]"
                      value={command}
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(e) => setCommand(id, e.target.value)}
                    />
                    {info?.builtin ? (
                      <button
                        type="button"
                        className="icon-btn shrink-0"
                        title="Reset to the preset"
                        aria-label={`Reset ${info.label} to the preset`}
                        disabled={command === info.preset}
                        onClick={() => info.preset !== null && setCommand(id, info.preset)}
                      >
                        <RotateCcw className="size-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn shrink-0"
                        title={settings.defaultAgent === id ? "It is the default agent: choose another default first" : "Remove"}
                        aria-label={`Remove ${id}`}
                        disabled={settings.defaultAgent === id}
                        onClick={() => removeAgent(id)}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                )}
              </Field>
            );
          })}
          <div className="grid gap-2 rounded-[12px] border border-steel/30 bg-inkwell/40 p-4">
            <div className="text-[13px] font-semibold">Add an agent</div>
            <p className="text-[12px] leading-snug text-fog">
              Another way to start an agent, such as a Pi launcher with its own model:{" "}
              <code className="font-mono text-bone">pi-claude -p {"{prompt}"}</code> or{" "}
              <code className="font-mono text-bone">pi --model openai/gpt-6 -p {"{prompt}"}</code>. Jobs and chats can pick it by name. Commands that
              run <code className="font-mono text-bone">pi</code> or a <code className="font-mono text-bone">pi-…</code> launcher (which passes
              its arguments on to Pi) keep one Pi session per item and chat.
            </p>
            <div className="grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
              <input
                className="field font-mono text-[13px]"
                aria-label="New agent's name"
                placeholder="pi-claude"
                value={newId}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setNewId(e.target.value)}
              />
              <input
                className="field font-mono text-[13px]"
                aria-label="New agent's command"
                placeholder={`${addId || "pi-claude"} -p {prompt}`}
                value={newCommand}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setNewCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAgent();
                  }
                }}
              />
              <button type="button" className="btn btn-ghost" disabled={!addId || addError !== null} onClick={addAgent}>
                <Plus aria-hidden className="size-3.5" />
                Add
              </button>
            </div>
            {addError && <p className="text-[12px] text-red">{addError}</p>}
            {fields.defaultAgent && <p className="text-[12px] text-red">{fields.defaultAgent}</p>}
            {/* Errors for agents no longer in the form, such as one removed while a job still uses it. */}
            {Object.entries(fields)
              .filter(([key]) => key.startsWith("agents.") && !Object.hasOwn(settings.agents, key.slice("agents.".length)))
              .map(([key, message]) => (
                <p key={key} className="text-[12px] text-red">
                  {key.slice("agents.".length)}: {message}
                </p>
              ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-4">
          <legend className="section-label mb-3">Capacity</legend>
          <div className="max-w-[220px]">
            <Field label="Runs at the same time" error={fields.maxConcurrent} hint="One run per job at a time either way.">
              {(p) => (
                <input
                  {...p}
                  type="number"
                  min={1}
                  max={8}
                  className="field tabular-nums"
                  value={settings.maxConcurrent}
                  onChange={(e) => update({ maxConcurrent: Number(e.target.value) })}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 border-t border-steel/35 pt-5">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {saved && <span className="text-[13px] text-green">Saved</span>}
          {error && <span className="text-[13px] text-red">{error}</span>}
        </div>
      </form>
    </>
  );
}
