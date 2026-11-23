$env:CLIPPER_PORT="4001"
$env:MEDIA_ROOT_DIR="D:/ClipperMedia"
$env:DATA_DIR="./data"
$env:NOTIFICATION_SERVICE_URL="http://localhost:4003"
$env:LLM_PROVIDER="mock"
Set-Location d:\Clipper
pnpm tsx apps/clipper-service/src/index.ts
