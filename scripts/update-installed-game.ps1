$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$gitDirText = (& git -C $repoRoot rev-parse --git-dir).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Could not locate the Git metadata directory."
}
$gitDir = if ([System.IO.Path]::IsPathRooted($gitDirText)) {
  [System.IO.Path]::GetFullPath($gitDirText)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $gitDirText))
}

$logPath = Join-Path $gitDir "breadmuncher-auto-update.log"
$lockPath = Join-Path $gitDir "breadmuncher-auto-update.lock"
$commitPath = Join-Path $gitDir "breadmuncher-installed-commit"
$versionPath = Join-Path $gitDir "breadmuncher-installed-version"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "BreadMuncherSimAutoUpdate-$PID"
$updateOutput = Join-Path $tempRoot "package"
$buildRoot = Join-Path $tempRoot "worktree"
$installedRoot = Join-Path $env:LOCALAPPDATA "breadmuncher_sim"
$updateExe = Join-Path $installedRoot "Update.exe"

function Write-UpdateLog([string]$message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $logPath -Value "[$timestamp] $message"
}

function Invoke-UpdateCommand(
  [string]$command,
  [string[]]$arguments,
  [string]$workingDirectory = $repoRoot
) {
  Write-UpdateLog ("Running: {0} {1}" -f $command, ($arguments -join " "))
  Push-Location -LiteralPath $workingDirectory
  try {
    # Windows PowerShell turns native stderr into error records. Git and npm
    # both use stderr for ordinary progress, so judge native commands only by
    # their process exit code while still copying all output into the log.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & $command @arguments 2>&1 | ForEach-Object { Write-UpdateLog $_.ToString() }
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
      throw "Command failed with exit code $exitCode`: $command"
    }
  } finally {
    Pop-Location
  }
}

function Get-NextVersion([string]$packagePath) {
  $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  $base = [version]$package.version
  $highest = $base

  if (Test-Path -LiteralPath $installedRoot) {
    Get-ChildItem -LiteralPath $installedRoot -Directory -Filter "app-*" | ForEach-Object {
      $candidateText = $_.Name.Substring(4)
      $candidate = $null
      if ([version]::TryParse($candidateText, [ref]$candidate) -and $candidate -gt $highest) {
        $highest = $candidate
      }
    }
  }

  if (Test-Path -LiteralPath $versionPath) {
    $candidate = $null
    $candidateText = (Get-Content -LiteralPath $versionPath -Raw).Trim()
    if ([version]::TryParse($candidateText, [ref]$candidate) -and $candidate -gt $highest) {
      $highest = $candidate
    }
  }

  if (($base.Major -gt $highest.Major) -or
      (($base.Major -eq $highest.Major) -and ($base.Minor -gt $highest.Minor))) {
    return "{0}.{1}.{2}" -f $base.Major, $base.Minor, ([Math]::Max(0, $base.Build))
  }

  $nextPatch = [Math]::Max(0, $highest.Build) + 1
  return "{0}.{1}.{2}" -f $highest.Major, $highest.Minor, $nextPatch
}

$lock = $null
try {
  # A background updater may already be building. Wait for it, then re-check
  # the installed commit so no commit is missed and no duplicate build occurs.
  for ($attempt = 0; $attempt -lt 300 -and -not $lock; $attempt++) {
    try {
      $lock = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    } catch [System.IO.IOException] {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $lock) {
    throw "Another updater did not finish within 10 minutes."
  }

  $head = (& git -C $repoRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not determine the current commit."
  }
  $installedCommit = if (Test-Path -LiteralPath $commitPath) {
    (Get-Content -LiteralPath $commitPath -Raw).Trim()
  } else {
    ""
  }
  if ($installedCommit -eq $head) {
    Write-UpdateLog "Commit $head is already installed; nothing to do."
    return
  }
  if (-not (Test-Path -LiteralPath $updateExe)) {
    throw "BreadMuncher Sim is not installed at $installedRoot. Run Setup once before using automatic updates."
  }

  Invoke-UpdateCommand "git" @("clone", "--shared", "--no-checkout", $repoRoot, $buildRoot)
  Invoke-UpdateCommand "git" @("checkout", "--detach", $head) $buildRoot

  $version = Get-NextVersion (Join-Path $buildRoot "package.json")
  $packagedApp = Join-Path $buildRoot "out\BreadMuncher Sim-win32-x64"
  Write-UpdateLog "Updating installed game to commit $head as version $version."
  Invoke-UpdateCommand "npm.cmd" @("ci", "--no-audit", "--no-fund") $buildRoot
  Invoke-UpdateCommand "npm.cmd" @("run", "check") $buildRoot
  Invoke-UpdateCommand "npm.cmd" @("run", "package:win") $buildRoot
  Invoke-UpdateCommand "node.exe" @(
    (Join-Path $buildRoot "scripts\make-local-update.cjs"),
    $packagedApp,
    $updateOutput,
    $version
  ) $buildRoot
  Invoke-UpdateCommand $updateExe @("--update", $updateOutput, "--silent")

  Set-Content -LiteralPath $versionPath -Value $version
  Set-Content -LiteralPath $commitPath -Value $head
  try {
    if (Test-Path -LiteralPath $tempRoot) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
  } catch {
    Write-UpdateLog "Update succeeded, but temporary build cleanup failed: $($_.Exception.Message)"
  }
  Write-UpdateLog "Installed commit $head successfully. The new version will run on the next launch."
} catch {
  Write-UpdateLog "UPDATE FAILED: $($_.Exception.Message)"
  exit 1
} finally {
  if ($lock) {
    $lock.Dispose()
  }
}
