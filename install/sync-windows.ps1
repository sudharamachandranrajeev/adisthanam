# adisthanam sync on Windows: the same commands as on Linux, for Syncthing
# running as you. Needs Node.js 24 or newer and Tailscale.
#
#   powershell -ExecutionPolicy Bypass -File sync-windows.ps1 status
#   powershell -ExecutionPolicy Bypass -File sync-windows.ps1 apply --dry-run
#   powershell -ExecutionPolicy Bypass -File sync-windows.ps1 quarantine FOLDER --from DEVICE --dry-run
#
# The plan is read from %USERPROFILE%\.config\adisthanam\sync.json.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Problem: Node.js 24 or newer is needed. Install it with: winget install OpenJS.NodeJS.LTS'
  exit 1
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) {
  Write-Host "Problem: Node.js 24 or newer is needed (found $(& node --version)). Update it with: winget upgrade OpenJS.NodeJS.LTS"
  exit 1
}
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  Write-Host 'Problem: Tailscale is needed; sync runs over Tailscale only. Install it from https://tailscale.com/download/windows and sign in.'
  exit 1
}

$sync = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\sync.ts'
& node $sync @args
exit $LASTEXITCODE
