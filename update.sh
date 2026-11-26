#!/usr/bin/env bash
# Clipper Studio — Safe Repository & Tool Updater (macOS / Linux)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CHECK_ONLY=0
AUTO_STASH=0
SKIP_PYTHON=0
YES=0

for arg in "$@"; do
  case "$arg" in
    --check)       CHECK_ONLY=1 ;;
    --auto-stash)  AUTO_STASH=1 ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --yes|-y)      YES=1 ;;
    *)
      echo "Usage: ./update.sh [--check] [--auto-stash] [--skip-python] [--yes]"
      exit 1
      ;;
  esac
done

echo ""
echo "====================================================="
echo "   Clipper Studio — Tool & Repository Updater"
echo "====================================================="
echo ""

if ! command -v git >/dev/null 2>&1; then
  echo "[error] Git is not installed or not on PATH." >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[error] $SCRIPT_DIR is not a Git repository." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
CUR_SHA="$(git rev-parse --short HEAD)"
echo "[update] Current branch: $BRANCH ($CUR_SHA)"

echo "[update] Fetching updates from origin..."
git fetch origin "$BRANCH" >/dev/null 2>&1 || git fetch origin >/dev/null 2>&1

REMOTE_REF="origin/$BRANCH"
BEHIND="$(git rev-list --count "HEAD..$REMOTE_REF" 2>/dev/null || echo 0)"
AHEAD="$(git rev-list --count "$REMOTE_REF..HEAD" 2>/dev/null || echo 0)"
REMOTE_SHA="$(git rev-parse --short "$REMOTE_REF" 2>/dev/null || echo unknown)"

echo "[update] Remote ($REMOTE_REF): $REMOTE_SHA | Behind: $BEHIND commit(s) | Ahead: $AHEAD commit(s)"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  if [[ "$BEHIND" -gt 0 ]]; then
    echo ""
    echo "[ok]     Update available ($BEHIND commit(s)):"
    git log --oneline -n 10 "HEAD..$REMOTE_REF"
    echo ""
    echo "[update] Run ./update.sh to install."
  else
    echo "[ok]     You are already up to date!"
  fi
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$SCRIPT_DIR/data/backups/$STAMP"
mkdir -p "$BACKUP_DIR"

if [[ -f "$SCRIPT_DIR/.env.local" ]]; then
  cp "$SCRIPT_DIR/.env.local" "$BACKUP_DIR/.env.local.bak"
  echo "[ok]     Backed up .env.local -> $BACKUP_DIR"
fi

if compgen -G "$SCRIPT_DIR/data/*.sqlite*" >/dev/null; then
  cp "$SCRIPT_DIR"/data/*.sqlite* "$BACKUP_DIR"/
  echo "[ok]     Backed up SQLite DBs -> $BACKUP_DIR"
fi

DID_STASH=0
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$AUTO_STASH" -eq 1 || "$YES" -eq 1 ]]; then
    echo "[warn]   Uncommitted local changes detected; stashing..."
    git stash push -u -m "clipper-updater-$STAMP" >/dev/null
    DID_STASH=1
  else
    echo "[warn]   Local uncommitted changes detected:"
    git status --short
    read -r -p "Stash local changes automatically and continue? [y/N] " ans
    if [[ ! "$ans" =~ ^[Yy] ]]; then
      echo "[error]  Aborted to protect local edits. Re-run with --auto-stash." >&2
      exit 1
    fi
    git stash push -u -m "clipper-updater-$STAMP" >/dev/null
    DID_STASH=1
  fi
fi

if [[ "$BEHIND" -gt 0 ]]; then
  echo "[update] Pulling latest changes from $REMOTE_REF..."
  if ! git pull --ff-only origin "$BRANCH"; then
    echo "[error]  Fast-forward pull failed. Resolve diverged branch manually." >&2
    exit 1
  fi
  echo "[ok]     Updated repository to $(git rev-parse --short HEAD)."
else
  echo "[ok]     Repository already at latest $REMOTE_REF — verifying deps & build."
fi

if [[ "$DID_STASH" -eq 1 ]]; then
  echo "[update] Restoring stashed local changes..."
  git stash pop || echo "[warn]   Stash pop had conflicts — check 'git stash list'."
fi

# Sync new .env.example keys into .env.local without overwriting existing ones
if [[ -f "$SCRIPT_DIR/.env.example" ]]; then
  if [[ ! -f "$SCRIPT_DIR/.env.local" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env.local"
    echo "[ok]     Created .env.local from .env.example"
  else
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*([A-Z][A-Z0-9_]+)= ]]; then
        key="${BASH_REMATCH[1]}"
        if ! grep -Eq "^[[:space:]]*#?[[:space:]]*${key}=" "$SCRIPT_DIR/.env.local"; then
          echo "$line" >> "$SCRIPT_DIR/.env.local"
          echo "[ok]     Synced new env key into .env.local: $key"
        fi
      fi
    done < "$SCRIPT_DIR/.env.example"
  fi
fi

echo "[update] Installing Node.js workspace dependencies..."
pnpm install --allow-build esbuild --allow-build nx

if [[ "$SKIP_PYTHON" -eq 0 ]] && command -v python3 >/dev/null 2>&1; then
  echo "[update] Updating Python dependencies..."
  python3 -m pip install -r requirements.txt --upgrade || true
  python3 -m py_compile clipper_tui.py apps/clipper-service/src/live/detect_face.py
fi

echo "[update] Building & typechecking monorepo..."
pnpm nx run-many -t build typecheck

echo ""
echo "[ok]     Clipper Studio upgrade complete!"
echo "[update] Start services: pnpm dev"
echo "[update] Launch TUI:     pnpm tui"
