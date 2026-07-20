#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

running=0

check_listener() {
  local label="$1"
  local port="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "RUNNING  $label (port $port)"
    running=1
  else
    echo "STOPPED  $label (port $port)"
  fi
}

check_process() {
  local label="$1"
  local pattern="$2"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "RUNNING  $label"
    running=1
  else
    echo "STOPPED  $label"
  fi
}

echo "Deacon status"
echo ""
check_listener "Next.js" "3000"
check_listener "Supabase API" "54321"
check_process "ngrok app tunnel" "ngrok http 3000"
check_process "Cloudflare Supabase tunnel" "cloudflared tunnel --url http://127.0.0.1:54321"
check_process "Media processing worker" "scripts/process-media.mjs"

if docker ps --format '{{.Names}}' | rg -q '^supabase_db_Deacon$'; then
  echo "RUNNING  Supabase database container"
  running=1
else
  echo "STOPPED  Supabase database container"
fi

echo ""
if [[ "$running" -eq 0 ]]; then
  echo "All Deacon services are stopped."
else
  echo "One or more Deacon services are still running."
fi

exit "$running"
