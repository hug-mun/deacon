#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! docker ps --format '{{.Names}}' | rg -q '^supabase_db_Deacon$'; then
  echo "Starting local Supabase..."
  supabase start --ignore-health-check
fi

echo "Applying local database migrations..."
supabase db push --local --yes

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"

# Keep the worker aligned with the local Supabase instance even when .env.local
# contains a stale or copied service key.
LOCAL_SERVICE_ROLE_KEY="$(supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY=//p')"
LOCAL_SERVICE_ROLE_KEY="${LOCAL_SERVICE_ROLE_KEY#\"}"
LOCAL_SERVICE_ROLE_KEY="${LOCAL_SERVICE_ROLE_KEY%\"}"
if [[ -n "${LOCAL_SERVICE_ROLE_KEY}" ]]; then
  export SUPABASE_SERVICE_ROLE_KEY="${LOCAL_SERVICE_ROLE_KEY}"
fi

WORKER_LOG="${ROOT_DIR}/.deacon-worker.log"
npm run worker:media >"${WORKER_LOG}" 2>&1 &
WORKER_PID=$!

cleanup() {
  if kill -0 "${WORKER_PID}" 2>/dev/null; then
    kill "${WORKER_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo ""
echo "Deacon local mode"
echo "  App:      http://localhost:3000"
echo "  Supabase: http://127.0.0.1:54321"
echo "  Worker log: ${WORKER_LOG}"
echo ""
echo "Stop the app with Ctrl+C. Use ./scripts/stop-all.sh to stop Supabase too."
echo ""

npm run dev -- --hostname 127.0.0.1 --port 3000
