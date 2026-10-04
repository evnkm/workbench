#!/usr/bin/env bash
# Start or stop a local dev worker and server against .workbench/ state.
# Usage: scripts/devctl.sh start|stop|restart [worker|server]
set -euo pipefail
cd "$(dirname "$0")/.."
D=$PWD/.workbench
mkdir -p "$D"
targets=${2:-"worker server"}
stop() { local f="$D/$1.pid"; if [[ -f $f ]] && kill -0 "$(cat "$f")" 2>/dev/null; then kill "$(cat "$f")"; while kill -0 "$(cat "$f")" 2>/dev/null; do sleep 0.2; done; fi; rm -f "$f"; }
start() { nohup node --env-file="$D/env" "apps/$1/src/main.ts" >>"$D/$1.log" 2>&1 & echo $! >"$D/$1.pid"; }
case $1 in
  start) for t in $targets; do start "$t"; done ;;
  stop) for t in $targets; do stop "$t"; done ;;
  restart) for t in $targets; do stop "$t"; start "$t"; done ;;
esac
