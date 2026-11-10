# pi-jobs

Scheduled, webhook-triggered and on-demand coding-agent jobs for your git repositories, with a
web UI to manage jobs, schedules and runs. It runs [Pi](https://pi.dev) by
default; Claude Code and Codex are selectable per job or as the default in Settings. From any Pi
session, [pi-shared](https://github.com/GeorgeTheo99/pi-shared)'s `jobs_*` tools create, change,
run and inspect jobs in natural language.

Each run works in a fresh git worktree, runs your check command, and leaves its changes on a
branch for review. pi-jobs never merges or deploys.

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

1. A trigger fires: the job's cron schedule, its webhook, or **Run now**.
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

Runs never merge or deploy. Before turning on branch pushes for a repository, check what its
`origin` does with new branches: deploy hooks that act on any branch, or a public host where the
branch becomes visible. Review a branch with the command shown on its run page, then merge it
yourself.

## Triggers

| Trigger | Notes |
|---|---|
| Schedule | Cron, in the server's local time zone. A fire is skipped while a run of the same job is queued or running. Fires missed while the server is down are not caught up |
| Webhook | `POST /api/hooks/<job id>` with `Authorization: Bearer <token>` (or `?token=`). The body becomes the payload: it replaces `{{payload}}` in the instructions, or is appended. Up to 20 queued runs per job |
| Manual | **Run now** in the UI, or `POST /api/jobs/<id>/run` |

Paused jobs ignore their schedule and webhook. Each job runs one at a time, and **Settings** caps
how many runs happen at once (default 2).

```sh
curl -X POST http://127.0.0.1:8790/api/hooks/1 \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"title": "Crash when saving", "details": "..."}'
```

## Agents

Settings holds one headless command line per agent. `{prompt}` becomes a single argument (never
passed through a shell); without it the prompt is appended.

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
Tokens are stored hashed. The UI asks for one on first visit and keeps it in the browser.

| Task | How |
|---|---|
| First token (bootstrap) | On the server: `pi-jobs token create <name>` prints a token once |
| More tokens | Settings → API tokens in a signed-in browser, which also shows the setup command for another machine |
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

State lives in `~/.local/state/pi-jobs/`: `pi-jobs.db` (SQLite: jobs, runs, settings, token hashes),
`runs/<id>.log`, and `worktrees/` for kept worktrees. Restarting the server fails runs that were
in progress. Queued runs resume.

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

Not built yet: merging or promoting result branches, notifications, catching up on schedule
fires missed while the server was down, and taking over a run interactively.
