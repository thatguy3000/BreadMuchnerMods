$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$updater = Join-Path $PSScriptRoot "update-installed-game.ps1"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$updater`""

# Keep the Git hook quick. The updater has its own lock, so several commits in
# rapid succession safely collapse into one update of the latest checkout.
Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList $arguments `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden

