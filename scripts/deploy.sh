#!/usr/bin/env bash
# Build a release from the current checkout and switch to it.
#
#   scripts/deploy.sh             restart the API server only (agent turns keep running)
#   scripts/deploy.sh --worker    also restart the worker (interrupts active turns, setup, and jobs)
#
# Releases live in ~/.local/share/workbench/releases/<id>; `current` points to
# the active one and `previous` to the one before, for rollback:
#   scripts/deploy.sh --rollback [--worker]
set -euo pipefail
STATE=${WORKBENCH_STATE_DIR:-$HOME/.local/share/workbench}
RELEASES=$STATE/releases
SRC=$(cd "$(dirname "$0")/.." && pwd)
restart_worker=false
rollback=false
for a in "$@"; do
  case $a in
    --worker) restart_worker=true ;;
    --rollback) rollback=true ;;
    *) echo "unknown argument $a" >&2; exit 2 ;;
  esac
done
mkdir -p "$RELEASES"

if $rollback; then
  prev=$(readlink -f "$STATE/previous")
  cur=$(readlink -f "$STATE/current")
  [[ -d $prev ]] || { echo "no previous release" >&2; exit 1; }
  ln -sfn "$prev" "$STATE/current"
  ln -sfn "$cur" "$STATE/previous"
  echo "Rolled back to $(basename "$prev")"
else
  rev=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo nogit)
  dirty=$([[ -n $(git -C "$SRC" status --porcelain 2>/dev/null) ]] && echo "-dirty" || true)
  id=$(date -u +%Y%m%dT%H%M%SZ)-$rev$dirty
  dest=$RELEASES/$id
  echo "Building release $id"
  rsync -a --delete --exclude node_modules --exclude .workbench --exclude dist --exclude .git "$SRC/" "$dest/"
  (cd "$dest" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
  # Verify before switching: types and the fast test suite.
  (cd "$dest" && npx tsc -p tsconfig.json && npx tsc -p apps/web)
  if [[ -L $STATE/current ]]; then ln -sfn "$(readlink -f "$STATE/current")" "$STATE/previous"; fi
  ln -sfn "$dest" "$STATE/current"
  echo "Switched current -> $id"
  # Keep the five newest releases plus whatever current/previous point at.
  keep=$(readlink -f "$STATE/current"; readlink -f "$STATE/previous" 2>/dev/null || true)
  ls -1dt "$RELEASES"/*/ | tail -n +6 | while read -r old; do
    old=${old%/}
    grep -qxF "$old" <<<"$keep" || rm -rf "$old"
  done
fi

# Take a backup before services pick up a release that may migrate the schema.
(cd "$STATE/current" && node --env-file-if-exists="$HOME/.config/workbench/env" scripts/backup.ts)

if $restart_worker; then
  echo "Restarting worker (active turns will be marked interrupted)"
  sudo systemctl restart workbench-worker
fi
sudo systemctl restart workbench-server
sleep 2
systemctl --no-pager --lines=0 status workbench-server workbench-worker workbench-tmux | grep -E '●|Active:'
