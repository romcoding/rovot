#!/usr/bin/env bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.rovot.daemon.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.rovot.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>rovot</string>
    <string>start</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>18789</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.rovot/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.rovot/launchd.err.log</string>
</dict>
</plist>
EOF
launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
echo "Installed LaunchAgent: $PLIST"
