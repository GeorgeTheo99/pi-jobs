import { RotateCcw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { TokensSection } from "@/components/TokensSection";
import { ErrorNote, Field, PageHeader, Skeleton } from "@/components/ui";
import { AGENT_IDS, ApiError, api, type Settings } from "@/lib/api";
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

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFields({});
    try {
      const { defaultAgent, agents, maxConcurrent } = settings;
      setSettings(await api.saveSettings({ defaultAgent, agents, maxConcurrent }));
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
            {settings.agentInfo.map((agent) => {
              const checked = settings.defaultAgent === agent.id;
              return (
                <button
                  key={agent.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => update({ defaultAgent: agent.id })}
                  className={`grid gap-1 rounded-[12px] border px-4 py-3 text-left transition-colors duration-150 ${
                    checked ? "border-amber/60 bg-amber/10" : "border-steel/50 bg-inkwell/40 hover:bg-channel"
                  }`}
                >
                  <span className={`text-[14px] font-semibold ${checked ? "text-amber" : "text-bone"}`}>{agent.label}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${agent.executable ? "bg-green" : "bg-red"}`} />
                    <span className={`truncate ${agent.executable ? "text-fog" : "text-red"}`} title={agent.executable ?? undefined}>
                      {agent.executable ?? "Not found on the server's PATH"}
                    </span>
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
          {AGENT_IDS.map((id) => {
            const info = settings.agentInfo.find((a) => a.id === id)!;
            const command = settings.agents[id].command;
            return (
              <Field key={id} label={info.label} error={fields[`agents.${id}`]}>
                {(p) => (
                  <div className="flex gap-2">
                    <input
                      {...p}
                      className="field font-mono text-[13px]"
                      value={command}
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(e) => update({ agents: { ...settings.agents, [id]: { command: e.target.value } } })}
                    />
                    <button
                      type="button"
                      className="icon-btn shrink-0"
                      title="Reset to the preset"
                      aria-label={`Reset ${info.label} to the preset`}
                      disabled={command === info.preset}
                      onClick={() => update({ agents: { ...settings.agents, [id]: { command: info.preset } } })}
                    >
                      <RotateCcw className="size-4" />
                    </button>
                  </div>
                )}
              </Field>
            );
          })}
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
