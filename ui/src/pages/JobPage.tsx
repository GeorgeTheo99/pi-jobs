import { MessagesSquare, Play, RadioTower, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ItemList } from "@/components/Items";
import { CopyButton, ErrorNote, Field, PageHeader, Skeleton, Switch } from "@/components/ui";
import {
  agentLabel,
  ApiError,
  api,
  apiUrl,
  jobToDraft,
  type AgentId,
  type Job,
  type JobDraft,
  type SchedulePreview,
  type WatchResult,
} from "@/lib/api";
import { SCHEDULE_PRESETS, dateTime, describeSchedule, relativeTime } from "@/lib/format";
import { useNow, usePoll } from "@/lib/usePoll";
import { useItems } from "@/lib/useItems";

const EMPTY_DRAFT: JobDraft = {
  name: "",
  kind: "agent",
  repoPath: "",
  baseRef: "main",
  prompt: "",
  command: "",
  agent: null,
  schedule: "",
  webhookEnabled: false,
  timeoutMinutes: 30,
  checkCommand: "",
  pushBranch: false,
  catchUp: true,
  retries: 2,
  watchCommand: "",
  shipCommand: "",
  releaseInstructions: "",
  verifyCommand: "",
  promoteInstructions: "",
  promoteVerifyCommand: "",
  autoRelease: false,
  approveRuns: false,
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
      // Pausing happens in the header, at once; saving the form leaves it as it is. A command job has
      // no agent, checks or release: drop anything set while the form was in Agent mode.
      const changes: Partial<JobDraft> =
        draft.kind === "command"
          ? { ...draft, agent: null, baseRef: "", prompt: "", checkCommand: "", watchCommand: "", pushBranch: false, shipCommand: "", releaseInstructions: "", verifyCommand: "", promoteInstructions: "", promoteVerifyCommand: "", autoRelease: false }
          : { ...draft, command: "" };
      delete changes.enabled;
      const saved = job ? await api.patchJob(job.id, changes) : await api.createJob({ ...draft, ...changes });
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
    if (!job || !window.confirm(`Delete "${job.name}" and its run history?${job.kind === "command" ? "" : " Branches it created stay in the repo."}`)) return;
    try {
      await api.deleteJob(job.id);
      navigate("/jobs");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const isCommand = draft.kind === "command";
  const defaultAgent = settings.data?.defaultAgent;
  // Settings' agents (built-ins, then added Pi launchers and the like), plus the job's own if it was since removed.
  const agentIds = Object.keys(settings.data?.agents ?? { pi: null, claude: null, codex: null });
  if (draft.agent && !agentIds.includes(draft.agent)) agentIds.push(draft.agent);

  return (
    <>
      <PageHeader
        title={job ? job.name : "New job"}
        meta={
          <Link to="/jobs" className="hover:text-bone">
            ← Jobs
          </Link>
        }
        actions={
          job && (
            <>
              <Link to={`/chats?jobId=${job.id}`} className="btn btn-ghost">
                <MessagesSquare aria-hidden className="size-3.5" />
                Chat about it
              </Link>
              <label className="flex items-center gap-2 text-[13px] text-fog">
                {job.enabled ? "Enabled" : "Paused"}
                <Switch
                  checked={job.enabled}
                  label={job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`}
                  onChange={(value) =>
                    void api.patchJob(job.id, { enabled: value }).then(onSaved, (err: Error) => setError(err.message))
                  }
                />
              </label>
              <button type="button" className="btn btn-ghost" onClick={() => void runNow()}>
                <Play aria-hidden className="size-3.5" />
                Run now
              </button>
            </>
          )
        }
      />

      <div className="grid gap-8">
        {job && <JobItems job={job} />}
        <EditSection open={!job}>
        <form onSubmit={(e) => void submit(e)} className="grid max-w-[760px] gap-7" noValidate>
          <Section title="What">
            {!job && (
              <div className="grid gap-2">
                <div role="radiogroup" aria-label="Kind of job" className="segmented justify-self-start">
                  <SegmentButton checked={!isCommand} onClick={() => set("kind", "agent")}>
                    Agent
                  </SegmentButton>
                  <SegmentButton checked={isCommand} onClick={() => set("kind", "command")}>
                    Command
                  </SegmentButton>
                </div>
                <p className="text-[12px] text-fog">
                  {isCommand
                    ? "Runs a shell command in a directory on its triggers, like a cron or launchd job: no agent, worktree or branch. Its output and exit code are the run."
                    : "Runs a coding agent in a fresh worktree of a git repository and leaves its changes on a branch for review."}
                </p>
                {fields.kind && <p className="text-[12px] text-red">{fields.kind}</p>}
              </div>
            )}
            <Field label="Name" error={fields.name}>
              {(p) => (
                <input
                  {...p}
                  className="field"
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder={isCommand ? "Nightly backup" : "Check for new gateway models"}
                />
              )}
            </Field>
            {isCommand ? (
              <>
                <Field label="Directory" error={fields.repoPath} hint="Absolute path the command runs in. It doesn't need to be a git repository.">
                  {(p) => (
                    <input
                      {...p}
                      className="field font-mono text-[13px]"
                      value={draft.repoPath}
                      onChange={(e) => set("repoPath", e.target.value)}
                      placeholder="/Users/me/local_code/backups"
                      spellCheck={false}
                      autoCapitalize="off"
                    />
                  )}
                </Field>
                <Field
                  label="Command"
                  error={fields.command}
                  hint={
                    <>
                      Run with <code className="font-mono text-bone">/bin/sh -c</code> as you, with the server's PATH. A webhook's body is in{" "}
                      <code className="font-mono text-bone">PI_JOBS_PAYLOAD</code>. A non-zero exit fails the run.
                    </>
                  }
                >
                  {(p) => (
                    <textarea
                      {...p}
                      className="field min-h-[96px] resize-y font-mono text-[13px] leading-relaxed"
                      value={draft.command}
                      onChange={(e) => set("command", e.target.value)}
                      placeholder="python3 backup.py run"
                      spellCheck={false}
                      autoCapitalize="off"
                    />
                  )}
                </Field>
              </>
            ) : (
              <>
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
                  or watch data should go; otherwise it is appended.
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
              </>
            )}
          </Section>

          {!isCommand && (
          <Section title="Agent">
            <div role="radiogroup" aria-label="Agent" className="segmented">
              <SegmentButton checked={draft.agent === null} onClick={() => set("agent", null)}>
                Default{defaultAgent ? ` (${agentLabel(defaultAgent)})` : ""}
              </SegmentButton>
              {agentIds.map((agent: AgentId) => (
                <SegmentButton key={agent} checked={draft.agent === agent} onClick={() => set("agent", agent)}>
                  {agentLabel(agent)}
                </SegmentButton>
              ))}
            </div>
            {fields.agent && <p className="text-[12px] text-red">{fields.agent}</p>}
          </Section>
          )}

          <Section title="Triggers">
            <ScheduleField value={draft.schedule} error={fields.schedule} onChange={(v) => set("schedule", v)} />
            {draft.schedule.trim() && (
              <ToggleRow
                label="Catch up missed runs"
                hint="If the server was off or the Mac asleep at a scheduled time, run once when it is back. Several missed times run once."
                checked={draft.catchUp}
                onChange={(v) => set("catchUp", v)}
              />
            )}
            <div className="grid gap-3">
              <ToggleRow
                label="Trigger from a webhook"
                hint="Let another service start a run with a POST, for example when a bug is filed or an error is logged."
                checked={draft.webhookEnabled}
                onChange={(v) => set("webhookEnabled", v)}
              />
              {draft.webhookEnabled && <WebhookDetails job={job} onRotated={onSaved} />}
            </div>
            {!isCommand && (
            <Field
              label="Watch command"
              error={fields.watchCommand}
              hint={
                <>
                  Optional. When set, each scheduled time runs this in the repository instead of the agent. Every JSON line it prints
                  with an <code className="font-mono text-bone">id</code> not seen before starts one run, with that line as the payload.
                </>
              }
            >
              {(p) => (
                <input
                  {...p}
                  className="field font-mono text-[13px]"
                  value={draft.watchCommand}
                  onChange={(e) => set("watchCommand", e.target.value)}
                  placeholder="node scripts/new-reports.mjs"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              )}
            </Field>
            )}
            {job?.watchCommand && <WatchStatus job={job} />}
            <ToggleRow
              label="Approve before running"
              hint={`Runs started by the schedule${isCommand ? " or webhook" : ", webhook or watch"} wait as Needs approval until you approve or dismiss them. Manual runs start right away.`}
              checked={draft.approveRuns}
              onChange={(v) => set("approveRuns", v)}
            />
          </Section>

          <Section title="Limits and checks">
            <div className={`grid gap-4 ${isCommand ? "sm:grid-cols-[140px_140px]" : "sm:grid-cols-[minmax(0,1fr)_140px_140px]"}`}>
              {!isCommand && (
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
              )}
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
              <Field label="Retries" error={fields.retries}>
                {(p) => (
                  <input
                    {...p}
                    type="number"
                    min={0}
                    max={5}
                    className="field tabular-nums"
                    value={draft.retries}
                    onChange={(e) => set("retries", Number(e.target.value))}
                  />
                )}
              </Field>
            </div>
            <p className="-mt-2 text-[12px] leading-snug text-fog">
              A run that fails or times out is tried again after 1 minute, then 4, 16 and so on. Canceled runs
              {isCommand ? "" : " and failed checks or pushes"} are not retried.
            </p>
            {!isCommand && (
            <ToggleRow
              label="Push the result branch"
              hint="After a successful run with changes, push its branch to the repository's origin so any machine can fetch it. If origin is GitHub, the branch becomes visible there."
              checked={draft.pushBranch}
              onChange={(v) => set("pushBranch", v)}
            />
            )}
          </Section>

          {!isCommand && (
          <Section title="Release">
            <p className="-mt-1 text-[13px] leading-snug text-fog">
              How a finished item goes out, like merging an approved pull request. Either gives finished items with changes an{" "}
              <span className="text-bone">Approve &amp; release</span> button.
            </p>
            <Field
              label="Release instructions"
              error={fields.releaseInstructions}
              hint="For the agent. It continues the item's conversation in a worktree of its result and, in that run only, may merge, push, deploy and publish. Say how this repository releases, or point to its AGENTS.md. It is never retried; a failure goes back to the agent with your next Make changes."
            >
              {(p) => (
                <textarea
                  {...p}
                  className="field min-h-[120px] resize-y leading-relaxed"
                  value={draft.releaseInstructions}
                  onChange={(e) => set("releaseInstructions", e.target.value)}
                  placeholder="Release this the way AGENTS.md says: rebase onto origin/main, run the tests, push main, wait for the deploy and check /api/health."
                />
              )}
            </Field>
            <Field
              label="Or a release script"
              error={fields.shipCommand}
              hint="A script instead of the agent: it runs in a checkout of the item's result with PI_JOBS_SHIP_COMMIT, PI_JOBS_SHIP_BRANCH, PI_JOBS_BASE_REF and PI_JOBS_REPO. Write it to fail closed; its output goes back to the agent with your next Make changes."
            >
              {(p) => (
                <input
                  {...p}
                  className="field font-mono text-[13px]"
                  value={draft.shipCommand}
                  onChange={(e) => set("shipCommand", e.target.value)}
                  placeholder="scripts/ship.sh"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              )}
            </Field>
            <Field
              label="Verify command"
              error={fields.verifyCommand}
              hint="Optional. Runs after a release (a health check, say), with the released commit in PI_JOBS_RELEASE_COMMIT; the release fails unless it exits 0."
            >
              {(p) => (
                <input
                  {...p}
                  className="field font-mono text-[13px]"
                  value={draft.verifyCommand}
                  onChange={(e) => set("verifyCommand", e.target.value)}
                  placeholder="curl -fsS http://127.0.0.1:8100/api/health"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              )}
            </Field>
            <Field
              label="Promote instructions"
              error={fields.promoteInstructions}
              hint="Optional, for a release in two stages. With these, the release above goes to staging only, and a released item waits as Staged until you promote it: the agent then ships exactly the commit staging verified, as these say. Promotions are never automatic or retried, and another item's staging release rules out promoting the one it replaced."
            >
              {(p) => (
                <textarea
                  {...p}
                  className="field min-h-[96px] resize-y leading-relaxed"
                  value={draft.promoteInstructions}
                  onChange={(e) => set("promoteInstructions", e.target.value)}
                  placeholder='Promote the staged commit the way docs/deployment.md says: git push origin "$PI_JOBS_RELEASE_COMMIT:refs/heads/main", then check that production reports that revision.'
                />
              )}
            </Field>
            <Field
              label="Promote verify command"
              error={fields.promoteVerifyCommand}
              hint="Optional. Runs after a promotion, with the promoted commit in PI_JOBS_RELEASE_COMMIT; the promotion fails unless it exits 0."
            >
              {(p) => (
                <input
                  {...p}
                  className="field font-mono text-[13px]"
                  value={draft.promoteVerifyCommand}
                  onChange={(e) => set("promoteVerifyCommand", e.target.value)}
                  placeholder="curl -fsS http://127.0.0.1:8121/api/health"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              )}
            </Field>
            <ToggleRow
              label="Release automatically"
              hint="Release each run whose check passed and whose report says the work was implemented or fixed, without waiting for you. Proposals, failures and unchecked work still wait. Needs a check command."
              checked={draft.autoRelease}
              onChange={(v) => {
                if (v && !window.confirm("Release automatically? Work that passes its check will merge, push and deploy without your review.")) return;
                set("autoRelease", v);
              }}
            />
            {fields.autoRelease && <p className="-mt-3 text-[12px] text-red">{fields.autoRelease}</p>}
            {draft.autoRelease && !draft.approveRuns && (draft.webhookEnabled || draft.watchCommand.trim()) && (
              <p className="-mt-3 text-[12px] leading-snug text-amber">
                With Approve before running off, a report from the {draft.watchCommand.trim() ? "watch" : "webhook"} can go to a release without
                anyone reading it. The agent treats reports as data, and the check and the report's verdict gate the release, but the agent
                writes both. Keep Approve before running on unless you trust where reports come from.
              </p>
            )}
          </Section>
          )}

          <div className="save-bar flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : job ? "Save changes" : "Create job"}
            </button>
            {savedAt && <span className="text-[13px] text-green">Saved</span>}
            {error && <span className="text-[13px] text-red">{error}</span>}
            {job && (
              <button type="button" className="btn btn-danger ml-auto" onClick={() => void remove()}>
                <Trash2 aria-hidden className="size-3.5" />
                Delete job
              </button>
            )}
          </div>
        </form>
        </EditSection>
      </div>
    </>
  );
}

/** The job's work, newest first, grouped into items like the Inbox. */
function JobItems({ job }: { job: Job }) {
  const { items, jobs, error } = useItems(4000, job.id);
  const byId = jobs.size > 0 ? jobs : new Map([[job.id, job]]);
  const now = useNow(30_000);
  const facts = [
    job.enabled ? null : "Paused",
    job.watchCommand ? "Watches for new items" : null,
    job.releaseInstructions || job.shipCommand ? (job.autoRelease ? "Releases automatically" : "Approve & release on finished items") : null,
    job.promoteInstructions ? "Releases to staging; you promote" : null,
    job.schedule ? `${describeSchedule(job.schedule)}${job.nextRunAt ? `, next ${relativeTime(job.nextRunAt, now)}` : ""}` : "No schedule",
    job.watchCommand && job.watchCheckedAt ? `checked ${relativeTime(job.watchCheckedAt, now)}` : null,
    job.webhookToken ? "Webhook on" : null,
    job.approveRuns ? "Runs wait for approval" : null,
    job.kind === "command" ? `Command in ${job.repoPath}` : `${agentLabel(job.effectiveAgent)} on ${job.baseRef}`,
  ].filter(Boolean);
  return (
    <section className="grid gap-3">
      <p className="text-[13px] text-fog">{facts.join(" · ")}</p>
      {job.watchError && <p className="text-[13px] text-red">Last watch check failed: {job.watchError}</p>}
      <h2 className="section-label mt-3">Items</h2>
      <ErrorNote error={error} />
      {items === null ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-steel/50 px-4 py-6 text-center text-[13px] text-fog">
          No runs yet. Use Run now, or wait for the schedule.
        </p>
      ) : (
        <ItemList items={items.slice(0, 30)} jobs={byId} />
      )}
    </section>
  );
}

/** An existing job's settings stay folded away under its items; a new job's form is the page. */
function EditSection({ open, children }: { open: boolean; children: ReactNode }) {
  if (open) return <>{children}</>;
  return (
    <details className="group rounded-[12px] border border-steel/30">
      <summary className="flex min-h-12 cursor-pointer items-center px-4 text-[14px] font-semibold text-bone hover:text-amber">
        Edit job
      </summary>
      <div className="border-t border-steel/30 px-4 py-5 sm:px-5">{children}</div>
    </details>
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

function WatchStatus({ job }: { job: Job }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<WatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setResult(await api.checkWatch(job.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };
  const problem = error ?? (result ? result.error : job.watchError);
  const summary = result
    ? `Checked now: ${result.runs.length} new, ${result.seen} seen before.`
    : job.watchCheckedAt
      ? `Last checked ${dateTime(job.watchCheckedAt)}.`
      : "Not checked yet.";
  return (
    <div className="grid gap-2 rounded-[12px] border border-steel/40 bg-inkwell/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-fog" role="status">
          {summary}
        </span>
        <button type="button" className="btn btn-ghost" disabled={checking || !job.enabled} onClick={() => void check()}>
          <RadioTower aria-hidden className="size-3.5" />
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      {problem && <p className="text-[12px] leading-snug text-red">{problem}</p>}
    </div>
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
