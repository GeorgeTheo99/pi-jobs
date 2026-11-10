import { Play, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { RunList } from "@/components/RunList";
import { CopyButton, ErrorNote, Field, PageHeader, Skeleton, Switch } from "@/components/ui";
import {
  AGENT_IDS,
  AGENT_LABELS,
  ApiError,
  api,
  apiUrl,
  jobToDraft,
  type AgentId,
  type Job,
  type JobDraft,
  type SchedulePreview,
} from "@/lib/api";
import { SCHEDULE_PRESETS, dateTime } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

const EMPTY_DRAFT: JobDraft = {
  name: "",
  repoPath: "",
  baseRef: "main",
  prompt: "",
  agent: null,
  schedule: "",
  webhookEnabled: false,
  timeoutMinutes: 30,
  checkCommand: "",
  pushBranch: false,
  enabled: true,
};

export function JobPage() {
  const { id } = useParams();
  const jobId = id === undefined ? null : Number(id);
  const [job, setJob] = useState<Job | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (jobId === null) return;
    api.job(jobId).then(setJob, setLoadError);
  }, [jobId]);

  if (jobId === null) return <JobEditor key="new" job={null} onSaved={setJob} />;
  if (loadError) return <ErrorNote error={loadError} />;
  if (!job) return <Skeleton rows={6} />;
  return <JobEditor key={job.id} job={job} onSaved={setJob} />;
}

function JobEditor({ job, onSaved }: { job: Job | null; onSaved: (job: Job) => void }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<JobDraft>(() => (job ? jobToDraft(job) : EMPTY_DRAFT));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const settings = usePoll(api.settings, null);
  const runs = usePoll(() => (job ? api.runs(job.id, 15) : Promise.resolve([])), job ? 4000 : null, [job?.id]);

  const set = <K extends keyof JobDraft>(key: K, value: JobDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSavedAt(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFields({});
    try {
      const saved = job ? await api.updateJob(job.id, draft) : await api.createJob(draft);
      onSaved(saved);
      setSavedAt(Date.now());
      if (!job) navigate(`/jobs/${saved.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!job) return;
    try {
      const run = await api.runJob(job.id);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    if (!job || !window.confirm(`Delete "${job.name}" and its run history? Branches it created stay in the repo.`)) return;
    try {
      await api.deleteJob(job.id);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const defaultAgent = settings.data?.defaultAgent;

  return (
    <>
      <PageHeader
        title={job ? job.name : "New job"}
        meta={
          <Link to="/" className="hover:text-bone">
            ← All jobs
          </Link>
        }
        actions={
          job && (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void runNow()}>
                <Play aria-hidden className="size-3.5" />
                Run now
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void remove()}>
                <Trash2 aria-hidden className="size-3.5" />
                Delete
              </button>
            </>
          )
        }
      />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <form onSubmit={(e) => void submit(e)} className="grid gap-7" noValidate>
          <Section title="What">
            <Field label="Name" error={fields.name}>
              {(p) => (
                <input {...p} className="field" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Check for new gateway models" />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <Field label="Repository" error={fields.repoPath} hint="Absolute path to a local git checkout.">
                {(p) => (
                  <input
                    {...p}
                    className="field font-mono text-[13px]"
                    value={draft.repoPath}
                    onChange={(e) => set("repoPath", e.target.value)}
                    placeholder="/Users/me/local_code/model-gateway"
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                )}
              </Field>
              <Field label="Base" error={fields.baseRef} hint="Branch or ref to start from.">
                {(p) => (
                  <input
                    {...p}
                    className="field font-mono text-[13px]"
                    value={draft.baseRef}
                    onChange={(e) => set("baseRef", e.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                )}
              </Field>
            </div>
            <Field
              label="Instructions"
              error={fields.prompt}
              hint={
                <>
                  Sent to the agent with notes about its worktree and branch. Put <code className="font-mono text-bone">{"{{payload}}"}</code> where webhook
                  data should go; otherwise it is appended.
                </>
              }
            >
              {(p) => (
                <textarea
                  {...p}
                  className="field min-h-[180px] resize-y leading-relaxed"
                  value={draft.prompt}
                  onChange={(e) => set("prompt", e.target.value)}
                  placeholder="Compare the providers' current model lists with config/config.yaml. Add any new models and update the tests."
                />
              )}
            </Field>
          </Section>

          <Section title="Agent">
            <div role="radiogroup" aria-label="Agent" className="segmented">
              <SegmentButton checked={draft.agent === null} onClick={() => set("agent", null)}>
                Default{defaultAgent ? ` (${AGENT_LABELS[defaultAgent]})` : ""}
              </SegmentButton>
              {AGENT_IDS.map((agent: AgentId) => (
                <SegmentButton key={agent} checked={draft.agent === agent} onClick={() => set("agent", agent)}>
                  {AGENT_LABELS[agent]}
                </SegmentButton>
              ))}
            </div>
            {fields.agent && <p className="text-[12px] text-red">{fields.agent}</p>}
          </Section>

          <Section title="Triggers">
            <ScheduleField value={draft.schedule} error={fields.schedule} onChange={(v) => set("schedule", v)} />
            <div className="grid gap-3">
              <ToggleRow
                label="Trigger from a webhook"
                hint="Let another service start a run with a POST, for example when a bug is filed or an error is logged."
                checked={draft.webhookEnabled}
                onChange={(v) => set("webhookEnabled", v)}
              />
              {draft.webhookEnabled && <WebhookDetails job={job} onRotated={onSaved} />}
            </div>
          </Section>

          <Section title="Limits and checks">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
              <Field label="Check command" error={fields.checkCommand} hint="Optional. Runs in the worktree after the agent; a non-zero exit fails the run.">
                {(p) => (
                  <input
                    {...p}
                    className="field font-mono text-[13px]"
                    value={draft.checkCommand}
                    onChange={(e) => set("checkCommand", e.target.value)}
                    placeholder="npm test"
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                )}
              </Field>
              <Field label="Timeout (minutes)" error={fields.timeoutMinutes}>
                {(p) => (
                  <input
                    {...p}
                    type="number"
                    min={1}
                    max={1440}
                    className="field tabular-nums"
                    value={draft.timeoutMinutes}
                    onChange={(e) => set("timeoutMinutes", Number(e.target.value))}
                  />
                )}
              </Field>
            </div>
            <ToggleRow
              label="Push the result branch"
              hint="After a successful run with changes, push its branch to the repository's origin so any machine can fetch it. If origin is GitHub, the branch becomes visible there."
              checked={draft.pushBranch}
              onChange={(v) => set("pushBranch", v)}
            />
            <ToggleRow
              label="Enabled"
              hint="Paused jobs ignore their schedule and webhook. You can still run them by hand."
              checked={draft.enabled}
              onChange={(v) => set("enabled", v)}
            />
          </Section>

          <div className="flex flex-wrap items-center gap-3 border-t border-steel/35 pt-5">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : job ? "Save changes" : "Create job"}
            </button>
            {savedAt && <span className="text-[13px] text-green">Saved</span>}
            {error && <span className="text-[13px] text-red">{error}</span>}
          </div>
        </form>

        {job && (
          <aside className="grid gap-3 lg:sticky lg:top-9">
            <h2 className="section-label">Recent runs</h2>
            {runs.data === null ? (
              <Skeleton />
            ) : runs.data.length === 0 ? (
              <p className="rounded-[14px] border border-dashed border-steel/60 px-4 py-6 text-center text-[13px] text-fog">
                No runs yet. Use Run now to try the job.
              </p>
            ) : (
              <RunList runs={runs.data} compact />
            )}
          </aside>
        )}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4">
      <legend className="section-label mb-4">{title}</legend>
      {children}
    </fieldset>
  );
}

function SegmentButton({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onClick}>
      {children}
    </button>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-5">
      <div>
        <div className="text-[13px] font-semibold">{label}</div>
        <p className="text-[12px] text-fog">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function ScheduleField({ value, error, onChange }: { value: string; error?: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const expression = value.trim();

  useEffect(() => {
    if (!expression) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      api.schedulePreview(expression).then((p) => !stale && setPreview(p), () => {});
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [expression]);

  const note = !expression
    ? "No schedule: the job runs only by hand or from its webhook."
    : preview && preview.valid
      ? `Next: ${preview.next.map(dateTime).join(" · ")}`
      : (preview?.error ?? " ");

  return (
    <Field label="Schedule" error={error ?? (expression && preview && !preview.valid ? note : undefined)} hint={note}>
      {(p) => (
        <div className="grid gap-2">
          <input
            {...p}
            className="field font-mono text-[13px]"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Cron, for example 0 6 * * *"
            spellCheck={false}
            autoCapitalize="off"
          />
          <div className="flex flex-wrap gap-1.5">
            {[{ label: "None", expression: "" }, ...SCHEDULE_PRESETS].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => onChange(preset.expression)}
                aria-pressed={expression === preset.expression}
                className="control-label rounded-full border border-steel/60 px-2.5 py-1 text-fog transition-colors duration-150 hover:bg-channel hover:text-bone aria-pressed:border-bone aria-pressed:bg-bone aria-pressed:text-midnight"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </Field>
  );
}

function WebhookDetails({ job, onRotated }: { job: Job | null; onRotated: (job: Job) => void }) {
  if (!job?.webhookToken) {
    return <p className="rounded-[10px] border border-steel/40 px-3.5 py-2.5 text-[13px] text-fog">Save the job to create its webhook URL and token.</p>;
  }
  const url = apiUrl(job.webhookPath);
  const curl = `curl -X POST ${url} \\\n  -H "Authorization: Bearer ${job.webhookToken}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title": "Crash when saving", "details": "..."}'`;
  const rotate = async () => {
    if (window.confirm("Make a new token? Services using the current one will stop working.")) onRotated(await api.rotateToken(job.id));
  };
  return (
    <div className="grid gap-2 rounded-[12px] border border-steel/40 bg-inkwell/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="control-label text-fog">POST with the token as a Bearer header or ?token=. The body becomes the payload.</span>
        <div className="flex shrink-0">
          <CopyButton value={curl} label="Copy curl command" />
          <button type="button" className="icon-btn" title="Make a new token" aria-label="Make a new token" onClick={() => void rotate()}>
            <RefreshCw className="size-4" />
          </button>
        </div>
      </div>
      <pre className="log-view overflow-x-auto rounded-[9px] px-3 py-2.5 text-bone">{curl}</pre>
    </div>
  );
}
