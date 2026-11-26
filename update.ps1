<#
.SYNOPSIS
  Clipper Studio — Safe Repository & Tool Updater (Windows PowerShell)

.DESCRIPTION
  Checks Git upstream for new Clipper Studio releases, backs up local SQLite
  databases and .env.local, pulls latest code, updates Node & Python dependencies,
  syncs new .env.example variables into .env.local, and verifies TypeScript/Python builds.

.EXAMPLE
  .\update.ps1            # Interactive update with safety checks & backup
  .\update.ps1 -Check     # Check if updates are available without modifying files
  .\update.ps1 -AutoStash # Automatically stash dirty tracked changes, pull, and re-apply
#>
param(
  [switch]$Check,
  [switch]$AutoStash,
  [switch]$SkipPython,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)) {
  $PSNativeCommandUseErrorActionPreference = $false
}
Set-Location $PSScriptRoot

function Write-Info($msg) { Write-Host "[update] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ok]     $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[warn]   $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[error]  $msg" -ForegroundColor Red }

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Command @Arguments 2>&1
    $code = $LASTEXITCODE
    return @{ Code = $code; Output = ($output | Out-String).Trim() }
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Invoke-NativeLive {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command @Arguments
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Magenta
Write-Host "   Clipper Studio — Tool & Repository Updater" -ForegroundColor Magenta
Write-Host "=====================================================" -ForegroundColor Magenta
Write-Host ""

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Err "Git is not installed or not on PATH."
  exit 1
}

$repoCheck = Invoke-NativeCapture 'git' @('rev-parse', '--is-inside-work-tree')
if ($repoCheck.Code -ne 0 -or $repoCheck.Output -ne 'true') {
  Write-Err "Current directory ($PSScriptRoot) is not a Git repository."
  exit 1
}

$branch = (Invoke-NativeCapture 'git' @('rev-parse', '--abbrev-ref', 'HEAD')).Output
$currentSha = (Invoke-NativeCapture 'git' @('rev-parse', '--short', 'HEAD')).Output
Write-Info "Current branch: $branch ($currentSha)"

Write-Info "Fetching updates from origin..."
$fetchRes = Invoke-NativeCapture 'git' @('fetch', 'origin', $branch)
if ($fetchRes.Code -ne 0) {
  Write-Warn "Could not fetch origin/$branch directly; fetching all origin refs..."
  $null = Invoke-NativeCapture 'git' @('fetch', 'origin')
}

$remoteRef = "origin/$branch"
$behindRes = Invoke-NativeCapture 'git' @('rev-list', '--count', "HEAD..$remoteRef")
$aheadRes  = Invoke-NativeCapture 'git' @('rev-list', '--count', "$remoteRef..HEAD")
$behind = if ($behindRes.Code -eq 0 -and $behindRes.Output -match '^\d+$') { [int]$behindRes.Output } else { 0 }
$ahead  = if ($aheadRes.Code  -eq 0 -and $aheadRes.Output  -match '^\d+$') { [int]$aheadRes.Output }  else { 0 }
$remoteShaRes = Invoke-NativeCapture 'git' @('rev-parse', '--short', $remoteRef)
$remoteSha = if ($remoteShaRes.Code -eq 0 -and $remoteShaRes.Output) { $remoteShaRes.Output } else { 'unknown' }

Write-Info "Remote ($remoteRef): $remoteSha | Behind: $behind commit(s) | Ahead: $ahead commit(s)"

if ($Check) {
  if ($behind -gt 0) {
    Write-Host ""
    Write-Ok "Update available! ($behind new commit(s) on $remoteRef)"
    $null = Invoke-NativeLive 'git' @('log', '--oneline', '-n', [string]([Math]::Min(10, $behind)), "HEAD..$remoteRef")
    Write-Host ""
    Write-Info "Run .\update.ps1 to install the update safely."
  } else {
    Write-Ok "You are already up to date!"
  }
  exit 0
}

# Warn if service ports appear open
try {
  $busy4001 = Get-NetTCPConnection -LocalPort 4001 -State Listen -ErrorAction SilentlyContinue
  $busy4003 = Get-NetTCPConnection -LocalPort 4003 -State Listen -ErrorAction SilentlyContinue
  if ($busy4001 -or $busy4003) {
    Write-Warn "Clipper services appear to be running on ports 4001/4003. Restart them after updating to load new code."
  }
} catch {}

# Back up local data/ & .env.local before pulling
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $PSScriptRoot "data\backups\$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

if (Test-Path (Join-Path $PSScriptRoot ".env.local")) {
  Copy-Item (Join-Path $PSScriptRoot ".env.local") (Join-Path $backupDir ".env.local.bak") -Force
  Write-Ok "Backed up .env.local -> $backupDir"
}

$sqliteFiles = Get-ChildItem -Path (Join-Path $PSScriptRoot "data") -Filter "*.sqlite*" -File -ErrorAction SilentlyContinue
foreach ($f in $sqliteFiles) {
  Copy-Item $f.FullName (Join-Path $backupDir $f.Name) -Force
}
if ($sqliteFiles) {
  Write-Ok "Backed up $($sqliteFiles.Count) SQLite file(s) -> $backupDir"
}

# Handle dirty working tree
$dirtyRes = Invoke-NativeCapture 'git' @('status', '--porcelain')
$didStash = $false
if ($dirtyRes.Output) {
  if ($AutoStash -or $Yes) {
    Write-Warn "Uncommitted local changes detected; stashing before pull..."
    $null = Invoke-NativeCapture 'git' @('stash', 'push', '-u', '-m', "clipper-updater-$stamp")
    $didStash = $true
  } else {
    Write-Warn "Local uncommitted changes detected:"
    $null = Invoke-NativeLive 'git' @('status', '--short')
    $ans = Read-Host "Stash local changes automatically and continue? [y/N]"
    if ($ans -notin @('y', 'Y', 'yes', 'YES')) {
      Write-Err "Aborted to protect local edits. Re-run with -AutoStash to stash automatically."
      exit 1
    }
    $null = Invoke-NativeCapture 'git' @('stash', 'push', '-u', '-m', "clipper-updater-$stamp")
    $didStash = $true
  }
}

if ($behind -gt 0) {
  Write-Info "Pulling latest changes from $remoteRef..."
  $pullCode = Invoke-NativeLive 'git' @('pull', '--ff-only', 'origin', $branch)
  if ($pullCode -ne 0) {
    Write-Err "Fast-forward pull failed (diverged local branch). Resolve manually or check git status."
    if ($didStash) { Write-Warn "Your stashed edits are saved under git stash list (clipper-updater-$stamp)." }
    exit 1
  }
  $newSha = (Invoke-NativeCapture 'git' @('rev-parse', '--short', 'HEAD')).Output
  Write-Ok "Updated repository to $newSha."
} else {
  Write-Ok "Git repository already at latest $remoteRef — verifying dependencies & build."
}

if ($didStash) {
  Write-Info "Re-applying stashed local changes..."
  $popCode = Invoke-NativeLive 'git' @('stash', 'pop')
  if ($popCode -ne 0) {
    Write-Warn "Merge conflict when restoring local stash. Your changes remain in 'git stash list'."
  }
}

# Sync new keys from .env.example -> .env.local without overwriting existing values
$envExamplePath = Join-Path $PSScriptRoot ".env.example"
$envLocalPath   = Join-Path $PSScriptRoot ".env.local"
if (Test-Path $envExamplePath) {
  if (-not (Test-Path $envLocalPath)) {
    Copy-Item $envExamplePath $envLocalPath
    Write-Ok "Created .env.local from .env.example"
  } else {
    $existingContent = Get-Content $envLocalPath -Raw
    $addedKeys = @()
    foreach ($line in Get-Content $envExamplePath) {
      if ($line -match '^\s*([A-Z][A-Z0-9_]+)\s*=') {
        $key = $Matches[1]
        if ($existingContent -notmatch "(?m)^\s*#?\s*$key\s*=") {
          Add-Content -Path $envLocalPath -Value $line
          $addedKeys += $key
        }
      }
    }
    if ($addedKeys.Count -gt 0) {
      Write-Ok "Added $($addedKeys.Count) new env key(s) to .env.local: $($addedKeys -join ', ')"
    }
  }
}

Write-Info "Installing / updating Node.js workspace dependencies..."
$pnpmCode = Invoke-NativeLive 'pnpm' @('install', '--allow-build', 'esbuild', '--allow-build', 'nx')
if ($pnpmCode -ne 0) {
  Write-Err "pnpm install failed."
  exit 1
}

if (-not $SkipPython -and (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Info "Updating Python packages from requirements.txt..."
  $null = Invoke-NativeLive 'python' @('-m', 'pip', 'install', '-r', 'requirements.txt', '--upgrade')
  $pyCode = Invoke-NativeLive 'python' @('-m', 'py_compile', 'clipper_tui.py', 'apps/clipper-service/src/live/detect_face.py')
  if ($pyCode -ne 0) {
    Write-Err "Python syntax check failed!"
    exit 1
  }
}

Write-Info "Building & typechecking TypeScript monorepo..."
$nxCode = Invoke-NativeLive 'pnpm' @('nx', 'run-many', '-t', 'build', 'typecheck')
if ($nxCode -ne 0) {
  Write-Err "Monorepo build/typecheck failed!"
  exit 1
}

Write-Host ""
Write-Ok "Clipper Studio upgrade complete!"
Write-Info "Start services with: pnpm dev  (or .\start-clipper.ps1)"
Write-Info "Launch TUI with:    pnpm tui  (or clipper.bat)"
