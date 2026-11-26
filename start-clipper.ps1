$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env.local'
if (-not (Test-Path $envFile)) {
  $exampleFile = Join-Path $PSScriptRoot '.env.example'
  if (Test-Path $exampleFile) {
    Copy-Item $exampleFile $envFile
    Write-Host "[start] Created .env.local from .env.example" -ForegroundColor Green
  }
}

if (-not $env:CLIPPER_PORT) { $env:CLIPPER_PORT = "4001" }
if (-not $env:DATA_DIR) { $env:DATA_DIR = "./data" }
if (-not $env:NOTIFICATION_SERVICE_URL) { $env:NOTIFICATION_SERVICE_URL = "http://localhost:4003" }
if (-not $env:CLIPPER_SERVICE_URL) { $env:CLIPPER_SERVICE_URL = "http://127.0.0.1:4001" }

Write-Host "[start] Launching Clipper Studio (clipper-service :4001 + notification-service :4003 + Next.js web :3000)..." -ForegroundColor Cyan
pnpm dev
