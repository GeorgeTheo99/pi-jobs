# pi-jobs

- Read `README.md` first.
- Server: `src/` (Node 24+ runs the TypeScript directly; imports use `.ts` extensions and only erasable syntax). UI: `ui/` (React 19, Vite, Tailwind 4).
- Verify with `npm run check` (typecheck, server tests, UI lint and tests, UI build).
- An installed service runs its checkout as the LaunchAgent `com.local.pi-jobs` on `127.0.0.1:8790`. After changes, run `npm run build` if the UI changed, then `launchctl kickstart -k gui/$(id -u)/com.local.pi-jobs` and check `curl -s http://127.0.0.1:8790/api/health`. A restart fails runs in progress, so check for active runs first.
- The API needs a bearer token (only `/api/health` and webhooks don't). Use the machine's Pi client token: `curl -H "Authorization: Bearer $(jq -r .token ~/.config/pi-jobs/client.json)" http://127.0.0.1:8790/api/jobs`. Never print or commit token values.
- The Pi `jobs_*` tools live in pi-shared (`extensions/pi-jobs`) and speak API version 1 (`API_VERSION` in `src/app.ts`); bump it, and update the tools, for incompatible API changes.
- Never point tests or experiments at live state in `~/.local/state/pi-jobs`. Use `PI_JOBS_STATE_DIR` and `PI_JOBS_PORT` for a scratch instance.
