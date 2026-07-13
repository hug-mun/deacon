#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! docker ps --format '{{.Names}}' | rg -q '^supabase_db_Deacon$'; then
  echo "Starting local Supabase..."
  supabase start --ignore-health-check
fi

echo ""
echo "Deacon local mode"
echo "  App:      http://localhost:3000"
echo "  Supabase: http://127.0.0.1:54321"
echo ""
echo "Stop the app with Ctrl+C. Use ./scripts/stop-all.sh to stop Supabase too."
echo ""

exec npm run dev -- --hostname 127.0.0.1 --port 3000
