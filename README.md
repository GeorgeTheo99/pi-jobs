# pi-jobs

Scheduled, webhook-triggered, watch-triggered and on-demand coding-agent jobs for your git repositories, with a
web UI to manage jobs, schedules and runs. It runs [Pi](https://pi.dev) by
default; Claude Code, Codex and your own launchers (a Pi launcher with its own model, say) are
selectable per job, per chat or as the default in Settings. From any Pi
session, [pi-shared](https://github.com/GeorgeTheo99/pi-shared)'s `jobs_*` tools create, change,
run and inspect jobs in natural language. [Command jobs](#command-jobs) run any shell command on
the same triggers, in place of cron or launchd jobs.

Each run works in a fresh git worktree, runs your check command, and leaves its changes on a
branch for review, like a pull request. **Approve & release** then has the agent release it the
way the repository does (merge, push, deploy, publish), following the job's release
instructions, or runs a ship script. Nothing merges or deploys until you press it, unless a job
releases automatically.

## Install (macOS)

Requires Node 24+ and git, plus the agent CLIs you want to use.

```sh
git clone https://github.com/GeorgeTheo99/pi-jobs.git && cd pi-jobs
./install.sh                    # build, LaunchAgent on 127.0.0.1:8790, ~/.local/bin/pi-jobs, Pi tools
pi-jobs token create admin      # paste this token into the UI at http://127.0.0.1:8790
```

With [pi-shared](https://github.com/GeorgeTheo99/pi-shared)'s setup, `pi-shared setup --pi-jobs local`
does the same and keeps pi-jobs updated with `pi-shared update`.

`install.sh` builds the server and UI, installs the LaunchAgent, links the CLI, and runs
`pi-jobs connect-local` so this machine's Pi tools use the local server. Re-run it after pulling
changes; it keeps the previous install's proxy host names and client token.

The server listens on loopback only. To reach it from other devices, put it behind a reverse
proxy (see [Behind a proxy](#behind-a-proxy)).

## Topology

Run pi-jobs where your repositories' main copies live and the machine stays on, typically one
always-on server: other machines push to it and manage jobs through its UI or their Pi tools, and
runs start from what was pushed. A machine with its own repositories (a work laptop, say) can
run its own pi-jobs. The software is the same either way: which machines run the server, and
which URL each machine's Pi tools use, are configuration.

## How a run works

1. A trigger fires: the job's cron schedule, its webhook, a new item from its watch command, or
   **Run now**. With **Approve before running**, a run from the schedule, webhook or watch waits
   as **Needs approval** until you approve it.
2. The runner fetches the base branch from `origin` and creates a git worktree from its pushed
   tip, on a new branch `pi-jobs/<job>/run-<id>`, so runs see what any machine pushed and never
   unpushed local work. `origin/<branch>` works the same way. Tags, revision expressions
   (`main~1`), `HEAD`, `refs/...` names, commits and repos without `origin` use local refs. Your
   checkout is never touched.
3. It starts the agent headless in that worktree with the job's instructions, plus a short note
   about the worktree, the branch and the rule not to push, merge or deploy.
4. If the job has a check command, it runs in the worktree after the agent exits 0.
5. Uncommitted changes are committed to the branch as `pi-jobs`.
   - **Succeeded:** the worktree is removed. The branch is kept if it has commits, otherwise deleted.
   - **Failed, timed out or canceled:** the worktree is kept for inspection.
6. With **Push the result branch** on, a succeeded run's branch is pushed to `origin`, so any
   machine can `git fetch origin <branch>`. A rejected push (a pre-receive hook, say) fails the
   run and keeps the worktree.

Runs never merge or deploy ([releasing](#release) is the owner's step). Before turning on branch pushes for a repository, check what its
`origin` does with new branches: deploy hooks that act on any branch, or a public host where the
branch becomes visible. Review a branch with the command shown on its run page, then merge it
yourself.

## Command jobs

A job's kind is **Agent** (the default, everything above) or **Command**, chosen when it is
created and fixed after. A command job runs a shell command on its triggers, like a cron or launchd
job, with pi-jobs' schedules (with catch-up), webhooks, approval, timeouts, retries, logs and
history:

- **What runs:** `/bin/sh -c <command>`, as you, in the job's directory (any directory, not only a
  git repository), with the server's environment. There is no agent, worktree, branch or commit:
  the command works on that directory as is.
- **Environment:** `PI_JOBS_RUN_ID`, `PI_JOBS_JOB_ID`, `PI_JOBS_TRIGGER`, `PI_JOBS_ATTEMPT`, and
  for a webhook, its body in `PI_JOBS_PAYLOAD` (over 64 KiB, in the file named by
  `PI_JOBS_PAYLOAD_FILE` instead).
- **Which command:** the job's command as it is when the run starts, so an edit applies to runs
  already queued or waiting for approval.
- **Outcome:** exit 0 succeeds; anything else fails and is retried like an agent run. The run page
  shows the end of what it printed; the log has all of it.
- **Not for command jobs:** an agent, instructions, base ref, check, watch or ship command, release
  instructions, branch pushes, Ask and Make changes. **Chat about it** works.
- **Stopping:** cancel and timeouts kill the command's process group and anything that inherited
  the run's `PI_JOBS_RUN_TOKEN`. Unlike an agent's worktree, the directory is shared, so processes
  are never found by their working directory.

The API takes `"kind": "command"` and `"command"` in the job body (`repoPath` is the directory);
`baseRef` and `prompt` come back empty.

## Triggers

| Trigger | Notes |
|---|---|
| Schedule | Cron, in the server's local time zone. A fire is skipped while a run of the same job is queued or running. With **Catch up missed runs** (on by default), times missed while the server was down or the Mac asleep run once when it is back; off, they are skipped |
| Webhook | `POST /api/hooks/<job id>` with `Authorization: Bearer <token>` (or `?token=`). The body becomes the payload: it replaces `{{payload}}` in the instructions, or is appended. Up to 20 queued runs per job |
| Watch | A shell command the schedule runs in the repository instead of the agent, for sources pi-jobs can't receive webhooks from (a cloud inbox behind a firewall, say). Every line it prints is a JSON object with an `id` (string or number, up to 200 characters); each `id` not seen before starts one run with that line as the payload. **Check now** in the UI, or `POST /api/jobs/<id>/watch`, checks immediately. The command must exit 0 within 2 minutes and print at most 1 MiB; the job page shows the last check's error, with the start of the command's last stderr line, so don't print secrets there. Items the queue has no room for start at a later check. The first check starts runs for everything printed, so print only what should be handled |
| Manual | **Run now** in the UI, or `POST /api/jobs/<id>/run` |

### Approval

With **Approve before running** on, runs from the schedule, webhook or watch are created as
**Needs approval**. The run page says what approving will start (agent, repository, base branch),
shows the webhook or watch item it is for (its title or description, then its plain fields) and the
job's instructions. They start only after **Approve and start** on the run page (or
`POST /api/runs/<id>/approve`); **Dismiss** (or `POST /api/runs/<id>/cancel`) cancels one without
running. Manual runs and retries of an approved run start without asking. A run waiting for
approval counts as queued: it holds back the job's schedule (a watch job's schedule still checks
its command) and counts toward its per-job queue limit, and it waits through server restarts. A
paused job's waiting runs can't be approved until it is resumed. Waiting runs head the
[Inbox](#the-inbox), with Approve and Dismiss on each card; the Runs page also filters to **Needs
approval** (`/runs?filter=approval`).

Payloads from webhooks and watches are marked in the prompt as outside data, never instructions.

### Ask and Make changes

Once a run finishes, you continue its item from the composer at the bottom of its page (or
`POST /api/runs/<id>/follow-up` with `{"instructions": "...", "mode": "ask" | "change"}`):

| | **Ask** | **Make changes** (the default mode) |
|---|---|---|
| For | A question: "why one order for the whole household?" | An instruction: "implement the proposal", "rename the button" |
| The agent | Reads code and runs read-only commands in a temporary checkout of the item's newest commits, then answers | Edits, tests and commits on a new branch built on the item's newest commits |
| Kept | The answer only: no branch, no commits, no check command | The answer and the commits, shown under **Changes** |

With Pi (or a `pi-…` launcher, see [Agents](#agents)), every run of an item continues one
conversation: pi-jobs gives the item a session ID (`pi --session-id`) and runs it in the same directory (`worktrees/job-<id>/item-<id>`), so the agent
remembers what it read, tried and was asked. A retry starts a new session, since its checkout starts
over. Other agents, and Pi when there is no earlier session, get the earlier run's instructions,
payload and report in the prompt instead. Your message comes first; where the context differs, it
wins. Reusing the item's directory removes a worktree an earlier run kept for inspection, after
committing anything left in it to that run's branch.

Messages are started by a person, like **Run now**: they need no approval and run while the job is
paused (retries, as for any run, only while the job is on). Presets fill in common messages
(implement the proposal, what are the risks, explain the changes, address review notes, shorten the
reply).

### Release

A finished item is like a pull request: its changes are on a branch, with its report and diff on
its page. **Approve & release** sends it out. A job releases in one of two ways, or not at all:

| | **Release instructions** (the agent) | **Ship command** (a script) |
|---|---|---|
| What runs | The job's agent, continuing the item's conversation, in a worktree of the item's newest commits on a new branch | `/bin/sh -c <ship command>` in a temporary checkout of the item's newest commits (deleted after) |
| What it may do | In this run only: merge, push, deploy and publish, as the instructions say. It is told to bring the commits onto the base branch on `origin` (rebasing and testing again if it moved), never force-push the base branch or skip hooks, stop at the first failure, and end with "Released" or "Not released" | Whatever the script does |
| Suits | Repositories whose release is documented for agents (AGENTS.md): "release the way AGENTS.md says, then check /api/health" | A fixed, fail-closed script |

A job has one or the other. Both get `PI_JOBS_SHIP_COMMIT`, `PI_JOBS_SHIP_BRANCH`,
`PI_JOBS_BASE_REF`, `PI_JOBS_REPO` and `PI_JOBS_ITEM_ID` (plus `PI_JOBS_RUN_ID` and
`PI_JOBS_JOB_ID`).

- **Who starts it.** You, with **Approve & release** on a finished item whose newest work succeeded
  (its check passed) and left changes (or `POST /api/runs/<id>/ship`). It needs no approval and
  runs while the job is paused. With **Release automatically** (`autoRelease`), a run that succeeds
  with changes releases at once; leave it off to review first.
- **Never retried.** A release may have done part of something irreversible, so after a failure you
  decide what comes next. **Release again** runs it once more, on the item's newest commits.
- **When it fails, the agent fixes it.** Send **Make changes** on the item: the agent continues the
  conversation (and gets a ship command's output as context). When that run succeeds, release again.
- **Done.** An agent's release succeeds only if it exits 0 and its report says "Released" (agents
  often exit 0 after stopping at a failed step). A succeeded release marks the item **Shipped**.
  Commits a release leaves off `origin/<base>` (a failed attempt's, say) stay on its branch for the
  next run; once everything is on `origin/<base>`, its branch is removed.
- **It runs as you.** The checkout holds what the agent wrote, ship script included, and runs with
  your credentials. Review **Changes** before releasing, especially changes to release tooling.
  Write ship scripts to fail closed (tests, a real install or a staging deploy before the step that
  can't be undone) and safe to run again.

### Chat

**Chat** manages pi-jobs by asking, from any browser: "set up a nightly job that checks
model-gateway for new models", "why did run #41 fail?", "pause the triage jobs", "approve what's
waiting", "switch Claude Code's command to my config directory". **Chat about it** on a job or an
item starts one with that context.

- **The agent reads, you change.** Each message runs the job agent from Settings once, in the
  chat's own directory, with the current state of pi-jobs (settings, jobs, API token names, recent
  runs, and the chat's job or item in full) and the paths of run logs. It can read run logs and
  repositories, and ends its reply with the changes it proposes. Each change is a card; nothing
  happens until you **Apply** it.
- **Cards are API calls.** Applying a card makes the same request as the matching button, with the
  same validation: create, change, pause or delete a job, Run now, check a watch, Ask or Make
  changes on an item, approve, dismiss, cancel, release, close or mark replied, change Settings
  (agent commands and added agents too), create or revoke an API token, replace a webhook token. A card says what
  it does and shows the exact old and new value of every field it changes. If its job or the
  settings changed since it was proposed, applying it fails and asks for a fresh proposal.
- **Review carefully.** Cards that set commands (check, watch, ship, agent), release instructions or
  automatic release, push branches, turn on a webhook, move a job to another repository, release,
  delete, or touch tokens are marked and are
  never part of **Apply all**. Instructions, payloads, reports and logs that the agent reads were
  written by others, so read these cards in full before applying them.
- **Secrets stay out of the conversation.** The agent never sees a token's value. A token a card
  creates or replaces appears once, on that card in your browser; it isn't stored with the chat
  or sent to the agent, which hears only that it was created.
- **One conversation.** With Pi, a chat's messages continue one session, and each turn tells the
  agent what became of the changes it proposed last. Other agents get the conversation so far in
  the prompt. A chat uses the default agent unless you pick another when starting it. One reply is
  written at a time per chat (at most 4 at once), for up to 15 minutes;
  **Stop** ends one. Pi's `jobs_*` tools aren't loaded in a chat's agent: it proposes, never acts.

The API: `GET`/`POST /api/chats` (`{"message", "jobId"?, "runId"?}`), `GET`/`DELETE
/api/chats/<id>`, `POST /api/chats/<id>/messages` and `/cancel`, `GET
/api/chats/<id>/turns/<turn>/log`, and `POST /api/chats/<id>/turns/<turn>/actions/<index>` with
`{"decision": "apply" | "dismiss"}` (the response carries a created token's value, once).

### The Inbox

The home page groups runs into **items**: a run started by a trigger, with its retries and
follow-ups (a support report's triage, your questions about it and the run that implements it are one item). Its
sections are **Waiting for you** (runs to approve, and proposals that need your decision, with
**Implement it**, which opens the composer with that instruction filled in), **In progress**, **To
review** (changes on a branch) and **Recent** (shipped, merged, closed, failed). **Check now** checks every
watch at once (`POST /api/watches/check`). The nav badge counts what is waiting for you.

A run page shows its whole item as a conversation: what started it, then each of your messages
and the agent's reply (its report, rendered; older long ones folded). Below that: the **Suggested
reply** to the reporter with **Copy reply** and a **Replied** switch, **Changes** (changed files with
their diffs, for the whole branch or one run, and the git commands to review, merge and push), the
composer, and the selected run's details and log. The verdict (implemented, fixed, needs your decision, can't reproduce, duplicate, not
actionable) comes from the report's first line or its `Verdict:` line, so job prompts that end with
a summary like that get the most from it.

Items are **Merged** once their branch's commits are in the job's base branch (`origin/<base>` as
last fetched, else the local branch). **Close item** marks one done without merging. The API behind
these: `GET /api/runs/<id>/thread` (the item's runs, oldest first, with reports), a finished run's `summary` (the agent's report; lists carry `summaryHeadline` and
`summaryVerdict` instead) and `merged`, `GET /api/runs/<id>/changes[?since=base]` (files and patch,
up to 1 MiB), and `POST /api/runs/<id>/replied` or `/closed` with `{"value": true|false}`. pi-jobs
never sends replies, and merges or pushes only in a release you start (or a job's Release
automatically).

Paused jobs ignore their schedule, webhook and watch. Each job runs one at a time, and **Settings** caps
how many runs happen at once (default 2).

A run that fails or times out is retried up to the job's **Retries** (default 2, at most 5) as a new
run with the same trigger and payload, after 1 minute, then 4, 16 and so on. That includes runs the
server stopped mid-way. Canceled runs, failed checks and failed pushes are not retried: the agent
already did its work. A waiting retry counts as queued, so it holds back the job's schedule and can
be canceled.

```sh
curl -X POST http://127.0.0.1:8790/api/hooks/1 \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"title": "Crash when saving", "details": "..."}'
```

## Agents

Settings holds one headless command line per agent. `{prompt}` becomes a single argument (never
passed through a shell); without it the prompt is appended. Besides the three built-ins, **Add an
agent** names another command line, typically a Pi launcher with its own model or profile:

| Name | Command |
|---|---|
| `pi-claude` | `pi-claude -p {prompt}` (a launcher script ending in `exec pi --model … "$@"`) |
| `pi-gpt` | `pi --model openai/gpt-6 -p {prompt}` |

Jobs, chats and the default pick agents by name; an agent a job uses can't be removed. Commands
whose program is `pi` or `pi-…` count as Pi: pi-jobs adds `--session-id <id>` right after the
program, so a launcher must pass its arguments on to Pi.

| Agent | Preset |
|---|---|
| Pi | `pi -p {prompt}` |
| Claude Code | `claude -p {prompt} --permission-mode bypassPermissions` |
| Codex | `codex exec --sandbox workspace-write {prompt}` |

If Claude Code is signed in under a non-default config directory, prefix its command with
`env CLAUDE_CONFIG_DIR=<dir>`.
Under Codex's sandbox the agent can't commit, because the worktree's git directory is outside it.
The runner commits its changes instead. The sandbox also blocks network access. To allow it, add
`-c sandbox_workspace_write.network_access=true`, but note that this lets a sandboxed run reach
this server's API (see Safety).

## Access

Every `/api` route except `/api/health` and webhooks needs `Authorization: Bearer <API token>`.
Tokens are stored hashed. The UI asks for one (or a password you set as a token) on first visit and keeps it in the browser.

| Task | How |
|---|---|
| First token (bootstrap) | On the server: `pi-jobs token create <name>` prints a token once |
| More tokens | Settings → API tokens in a signed-in browser, which also shows the setup command for another machine |
| Choose the token yourself (a password) | Fill in **Token** when creating one in Settings, or `pi-jobs token create <name> --set` (reads it from stdin, prompting twice on a terminal). Anything goes, `password` included: 1 to 200 letters, digits, symbols or spaces, not starting or ending with a space (HTTP headers drop those). Sign in to the UI with it like any token |
| List or revoke | Settings → API tokens, or `pi-jobs token list` / `pi-jobs token revoke <name>` |

`pi-jobs` is `~/.local/bin/pi-jobs`, linked to `bin/pi-jobs` by the install script.

## From Pi

pi-shared's `jobs_*` tools ([`extensions/pi-jobs`](https://github.com/GeorgeTheo99/pi-shared/tree/main/extensions/pi-jobs))
call this API. They are registered only when a server is configured:

| Machine | Setup |
|---|---|
| The server itself | Done by `install.sh` (`pi-jobs connect-local`: saves `~/.config/pi-jobs/client.json` with `http://127.0.0.1:8790`) |
| Another tailnet machine | Create a token in Settings, then run `pi-shared setup --pi-jobs <url>` there and paste the token when asked (`--pi-jobs-token-file <file>` for scripts). Without pi-shared's setup: `pi-jobs client-config <url>` from a pi-jobs checkout, or write `client.json` by hand |

A loopback client sends the checkout's own path. A remote client sends the checkout's git
remotes, and `POST /api/repos/resolve` picks the matching checkout under `PI_JOBS_REPO_ROOTS`
(default `~/local_code`): an SSH remote like `me@studio:repos/app.git` matches a checkout whose
`origin` is `~/repos/app.git`; SSH remotes are assumed to name a path on this server, and two
SSH remotes on different hosts never match through their paths. `GET /api/health` reports `apiVersion` (currently 1); the tools
refuse a server with another version.

## Behind a proxy

To serve pi-jobs under a path such as `/pi-jobs/` (Caddy, Tailscale Serve, nginx):

- Strip the prefix and send `X-Forwarded-Prefix: /pi-jobs`; the server sets the UI's
  `<base href>` from it.
- Add the host names clients use (`Host` header) to `PI_JOBS_ALLOWED_HOSTS` when installing:
  `PI_JOBS_ALLOWED_HOSTS=host.example.ts.net,100.x.y.z ./install.sh`. Later runs keep them.
- Keep it private: the token is the only login. A tailnet-only route (for example Tailscale Serve
  without Funnel) is a good fit; `GET /api/health` is the only unauthenticated API route.

## Safety

- Agents run as you, with your credentials and no sandbox (except Codex's own). Treat a job's
  instructions and webhook payloads like a prompt you typed into an unattended session.
- The server listens on `127.0.0.1`. It rejects other `Host` headers (DNS rebinding) and
  non-JSON or cross-origin writes (CSRF). To expose webhooks through a proxy, add its host name to
  `PI_JOBS_ALLOWED_HOSTS`.
- An API token can change agent commands, which means running arbitrary commands as you: treat
  tokens like SSH keys and revoke unused ones. Unsandboxed agents (Pi, Claude Code) run as you and
  could read a token file or mint one with the CLI, so tokens protect against other machines,
  other local users and sandboxed agents, not against your own agents. The Codex preset keeps
  networking off. Instructions and payloads are passed as process arguments, so they are visible
  in `ps` to other local users.
- When an agent exits, is canceled or times out, the processes it left behind are killed: its
  process group, anything that inherited the run's `PI_JOBS_RUN_TOKEN` (macOS `ps -E`), and
  anything whose working directory is inside the run's worktree. That catches commands that Pi's
  bash tool detaches into their own sessions. A detached process that also changed directory out
  of the worktree, and is a platform binary that hides its environment, would be missed.
- Variables from an enclosing agent session (`PI_SESSION_*`, `CLAUDECODE`, …) are removed from
  agent environments. Runs get `PI_JOBS_RUN_ID`, `PI_JOBS_JOB_ID` and a random `PI_JOBS_RUN_TOKEN`.

## Operating

| Task | Command |
|---|---|
| Install, reinstall or upgrade | `git pull && ./install.sh` (`PI_JOBS_ALLOWED_HOSTS=<hosts>` to change proxy host names) |
| Restart after a code change | `launchctl kickstart -k gui/$(id -u)/com.local.pi-jobs` (rebuild the UI first if it changed) |
| Check | `pi-jobs verify` (LaunchAgent loaded, `/api/health` answers) |
| Uninstall | `launchctl bootout gui/$(id -u)/com.local.pi-jobs && rm ~/Library/LaunchAgents/com.local.pi-jobs.plist` |
| Server log | `~/.local/state/pi-jobs/server.log` |

State lives in `~/.local/state/pi-jobs/`: `pi-jobs.db` (SQLite: jobs, runs, chats, settings, token
hashes), `runs/<id>.log`, `chats/` (each chat's working directory and reply logs), and `worktrees/`
for kept worktrees. Watch items seen are kept per job (`watch_items`). Restarting the server fails runs that were
in progress (and retries them if their job allows). Queued runs resume, and runs waiting for
approval keep waiting.

| Variable | Default |
|---|---|
| `PI_JOBS_PORT` | `8790` |
| `PI_JOBS_HOST` | `127.0.0.1` |
| `PI_JOBS_STATE_DIR` | `~/.local/state/pi-jobs` |
| `PI_JOBS_ALLOWED_HOSTS` | (none; comma-separated extra host names) |
| `PI_JOBS_REPO_ROOTS` | `~/local_code` (`:`-separated directories whose child checkouts remote clients can match) |

## Development

Node 24+ runs the TypeScript server directly; there is no server build step. The UI is React 19,
Vite and Tailwind 4 in a dark navy and amber theme.

| Command | What it does |
|---|---|
| `npm run dev` | Server with `--watch` on :8790 |
| `npm --prefix ui run dev` | Vite dev server, proxying `/api` to :8790 |
| `npm run check` | Typecheck, server tests, UI lint and tests, UI build |

Not built yet: notifications, and taking over a run interactively. Merging and pushing happen only
in a release, which you start (or a job's Release automatically), on purpose: pushing a base
branch deploys some apps.
