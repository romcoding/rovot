$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$out = Join-Path $root "desktop\backend-bin"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
python -m pyinstaller --clean -F -n rovot-daemon -c -p (Join-Path $root "src") (Join-Path $root "src\rovot\cli.py")
Copy-Item (Join-Path $root "dist\rovot-daemon.exe") (Join-Path $out "rovot-daemon.exe") -Force
Write-Host "Built backend: $out\rovot-daemon.exe"
