#!/bin/sh
# Builds pi-jobs and installs (or reinstalls) it as a LaunchAgent serving this checkout on
# 127.0.0.1:8790, links the pi-jobs CLI into ~/.local/bin, and points this machine's Pi tools at
# the local server. Safe to re-run after pulling changes.
#
#   PI_JOBS_ALLOWED_HOSTS  extra Host names for a reverse proxy (comma-separated); when unset, the
#                          value of an existing install is kept
#   PI_JOBS_SKIP_BUILD=1   reuse existing node_modules and ui/dist
#   PI_JOBS_NO_CLIENT=1    leave ~/.config/pi-jobs/client.json alone
#
# A LaunchAgent, not a LaunchDaemon: agents need the owner's GUI session for keychain sign-ins.
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
label=com.local.pi-jobs
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"
state="${PI_JOBS_STATE_DIR:-$HOME/.local/state/pi-jobs}"
port=8790

[ "$(uname -s)" = Darwin ] || { echo "pi-jobs install.sh supports macOS (launchd) only" >&2; exit 1; }
node=$(command -v node) || { echo "pi-jobs needs Node 24 or newer on PATH" >&2; exit 1; }
"$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' ||
    { echo "pi-jobs needs Node 24 or newer (found $("$node" --version))" >&2; exit 1; }

if [ "${PI_JOBS_SKIP_BUILD:-}" != 1 ]; then
    echo "Building pi-jobs…"
    (cd "$repo" && npm ci --no-audit --no-fund --ignore-scripts --loglevel=error)
    (cd "$repo/ui" && npm ci --no-audit --no-fund --ignore-scripts --loglevel=error && npm run --silent build >/dev/null)
fi
[ -f "$repo/ui/dist/index.html" ] || { echo "The UI build is missing: $repo/ui/dist" >&2; exit 1; }

# Keep a previous install's proxy host names unless new ones are given.
if [ -z "${PI_JOBS_ALLOWED_HOSTS+set}" ] && [ -f "$plist" ]; then
    PI_JOBS_ALLOWED_HOSTS=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:PI_JOBS_ALLOWED_HOSTS" "$plist" 2>/dev/null || true)
fi
allowed_hosts=${PI_JOBS_ALLOWED_HOSTS:-}
case "$allowed_hosts" in *[!A-Za-z0-9.,:\[\]-]*) echo "PI_JOBS_ALLOWED_HOSTS may hold only host names, IPs and commas" >&2; exit 1 ;; esac
# launchd's default PATH lacks Homebrew and ~/.local/bin, where the agent CLIs live.
path="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$state" "$(dirname "$plist")"
chmod 700 "$state"
# Owner-only, as pi-setup's service-ownership checks require.
rm -f "$plist"
(umask 077 && cat > "$plist") <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>$node</string><string>src/main.ts</string></array>
<key>WorkingDirectory</key><string>$repo</string>
<key>EnvironmentVariables</key><dict>
  <key>PATH</key><string>$path</string>
  <key>PI_JOBS_PORT</key><string>$port</string>
  <key>PI_JOBS_STATE_DIR</key><string>$state</string>
  <key>PI_JOBS_ALLOWED_HOSTS</key><string>$allowed_hosts</string>
</dict>
<key>StandardOutPath</key><string>$state/server.log</string>
<key>StandardErrorPath</key><string>$state/server.log</string>
<key>Umask</key><integer>63</integer>
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
</dict></plist>
EOF
chmod 600 "$plist"
plutil -lint "$plist" >/dev/null

launchctl bootout "$domain/$label" 2>/dev/null || true
# bootout returns before the old instance is gone; bootstrap fails (error 5) until it is.
i=0
while launchctl print "$domain/$label" >/dev/null 2>&1 && [ $i -lt 40 ]; do
    sleep 0.5
    i=$((i + 1))
done
launchctl bootstrap "$domain" "$plist"

i=0
until curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ $i -lt 40 ] || { echo "pi-jobs did not become healthy; see $state/server.log" >&2; exit 1; }
    sleep 0.5
done

mkdir -p "$HOME/.local/bin"
ln -sf "$repo/bin/pi-jobs" "$HOME/.local/bin/pi-jobs"
[ "${PI_JOBS_NO_CLIENT:-}" = 1 ] || PI_JOBS_STATE_DIR="$state" "$node" "$repo/src/cli.ts" connect-local

echo "pi-jobs is running: http://127.0.0.1:$port (log: $state/server.log)"
echo "Sign in to the UI with a token from: pi-jobs token create <name>"
