#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_PORT="${DEACON_APP_PORT:-3000}"
SUPABASE_PORT="${DEACON_SUPABASE_PORT:-54321}"
NGROK_LOG="$(mktemp -t deacon-ngrok.XXXXXX.log)"
CLOUDFLARED_LOG="$(mktemp -t deacon-cloudflared.XXXXXX.log)"
NGROK_PID=""
CLOUDFLARED_PID=""

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$NGROK_PID" ]]; then kill "$NGROK_PID" 2>/dev/null || true; fi
  if [[ -n "$CLOUDFLARED_PID" ]]; then kill "$CLOUDFLARED_PID" 2>/dev/null || true; fi
  rm -f "$NGROK_LOG" "$CLOUDFLARED_LOG"
}

trap cleanup EXIT INT TERM

if ! docker ps --format '{{.Names}}' | rg -q '^supabase_db_Deacon$'; then
  echo "Starting local Supabase..."
  supabase start --ignore-health-check
fi

echo "Starting Supabase API tunnel..."
cloudflared tunnel --url "http://127.0.0.1:${SUPABASE_PORT}" >"$CLOUDFLARED_LOG" 2>&1 &
CLOUDFLARED_PID=$!

SUPABASE_PUBLIC_URL=""
for _ in {1..60}; do
  SUPABASE_PUBLIC_URL="$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | tail -1 || true)"
  if [[ -n "$SUPABASE_PUBLIC_URL" ]]; then break; fi
  sleep 1
done

if [[ -z "$SUPABASE_PUBLIC_URL" ]]; then
  echo "Could not find the Cloudflare Supabase URL."
  echo "Cloudflare log: $CLOUDFLARED_LOG"
  exit 1
fi

echo "Starting app tunnel..."
ngrok http "$APP_PORT" >"$NGROK_LOG" 2>&1 &
NGROK_PID=$!

APP_PUBLIC_URL=""
for _ in {1..60}; do
  APP_PUBLIC_URL="$(node -e 'fetch("http://127.0.0.1:4040/api/tunnels").then(r=>r.json()).then(d=>{const t=(d.tunnels||[]).find(x=>x.config?.addr?.includes(":3000")); if(t) process.stdout.write(t.public_url)}).catch(()=>{})' || true)"
  if [[ -n "$APP_PUBLIC_URL" ]]; then break; fi
  sleep 1
done

if [[ -z "$APP_PUBLIC_URL" ]]; then
  echo "Could not find the ngrok app URL."
  echo "ngrok log: $NGROK_LOG"
  exit 1
fi

echo ""
echo "Deacon remote-test mode"
echo "  Open on your phone: $APP_PUBLIC_URL"
echo "  Supabase API tunnel: $SUPABASE_PUBLIC_URL"
echo ""
echo "This mode uses temporary URLs. Keep this shell open. Ctrl+C stops the app tunnels; use ./scripts/stop-all.sh to stop Supabase too."
echo ""

NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_PUBLIC_URL" \
  npm run dev -- --hostname 0.0.0.0 --port "$APP_PORT"
