#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

stop_matching() {
  local label="$1"
  local pattern="$2"
  local pids
  pids="$(pgrep -f "$pattern" || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping $label..."
    for pid in $pids; do
      if [[ "$pid" != "$$" ]]; then kill "$pid" 2>/dev/null || true; fi
    done
  fi
}

stop_matching "Next.js" "next dev --hostname 0.0.0.0 --port 3000"
stop_matching "Next.js" "next dev --hostname 127.0.0.1 --port 3000"
stop_matching "ngrok" "ngrok http 3000"
stop_matching "Cloudflare Tunnel" "cloudflared tunnel --url http://127.0.0.1:54321"

if docker ps --format '{{.Names}}' | rg -q '^supabase_.*_Deacon$'; then
  echo "Stopping Supabase containers while preserving the database volume..."
  supabase stop
else
  echo "Supabase containers are already stopped."
fi

echo ""
echo "Run ./scripts/status.sh to verify the final state."
