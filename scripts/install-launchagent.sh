#!/bin/sh
# Installs (or reinstalls) pi-jobs as a LaunchAgent that serves this checkout on 127.0.0.1:8790.
# A LaunchAgent, not a LaunchDaemon: agents need the owner's GUI session for keychain sign-ins.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
label=com.local.pi-jobs
plist="$HOME/Library/LaunchAgents/$label.plist"
state="$HOME/.local/state/pi-jobs"
node=$(command -v node)
# launchd's default PATH lacks Homebrew and ~/.local/bin, where the agent CLIs live.
path="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Extra host names the server answers to when reached through a proxy (comma-separated),
# e.g. the tailnet name and IPs that Caddy and Tailscale Serve forward as the Host header.
allowed_hosts=${PI_JOBS_ALLOWED_HOSTS:-}

if [ ! -f "$repo/ui/dist/index.html" ]; then
    echo "Build the UI first: npm ci && npm --prefix ui ci && npm run build" >&2
    exit 1
fi

mkdir -p "$state" "$(dirname "$plist")"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>$node</string><string>src/main.ts</string></array>
<key>WorkingDirectory</key><string>$repo</string>
<key>EnvironmentVariables</key><dict>
  <key>PATH</key><string>$path</string>
  <key>PI_JOBS_PORT</key><string>8790</string>
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
plutil -lint "$plist" >/dev/null

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
# bootout returns before the old instance is gone; bootstrap fails (error 5) until it is.
i=0
while launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && [ $i -lt 30 ]; do
    sleep 0.5
    i=$((i + 1))
done
launchctl bootstrap "gui/$(id -u)" "$plist"
mkdir -p "$HOME/.local/bin"
ln -sf "$repo/bin/pi-jobs" "$HOME/.local/bin/pi-jobs"
echo "Installed $label: http://127.0.0.1:8790 (log: $state/server.log)"
echo "CLI: ~/.local/bin/pi-jobs (create a token with: pi-jobs token create <name>)"
