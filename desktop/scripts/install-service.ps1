$ErrorActionPreference = "Stop"
$taskName = "RovotDaemon"
$cmd = "rovot start --host 127.0.0.1 --port 18789"
schtasks /Delete /TN $taskName /F | Out-Null 2>$null
schtasks /Create /TN $taskName /SC ONLOGON /RL LIMITED /TR $cmd
Write-Host "Installed Scheduled Task: $taskName"
