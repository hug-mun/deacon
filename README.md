# Deacon

Deacon is a private knowledge base for master classes. The MVP is designed for an iPad-first web experience where recordings, screenshots, and notes become searchable and available to grounded chat.

The current implementation has:

- Next.js on Vercel-style hosting;
- local Supabase Auth, Postgres, pgvector, Realtime, and Storage;
- email/password authentication;
- RLS-protected user data;
- Phase 2 image upload and library display;
- temporary remote phone testing through ngrok and Cloudflare Tunnel.

Read the system design in [architecture.md](architecture.md), the product design in [masterclass-kb-mvp-spec.md](masterclass-kb-mvp-spec.md), and the build plan in [masterclass-kb-build-spec.md](masterclass-kb-build-spec.md).

## Current status

Completed:

1. Phase 0 — project scaffold, Supabase schema, pgvector, RLS, and profile trigger.
2. Phase 1 — email/password account creation, sign-in, protected routes, and sign-out.
3. Phase 2 — image selection, automatic session creation, SHA-256 exact-duplicate check, direct Storage upload, finalization, and library preview.

Next:

- Phase 3: image thumbnails, OCR, vision description, embeddings, and `ready` status.
- Phase 5: video upload, audio extraction, Whisper transcription, timestamped chunks, and transcript download.

## Prerequisites

Install or have available:

- Node.js and npm;
- Docker Desktop, running;
- Supabase CLI;
- ngrok, only for remote phone testing of the app;
- Cloudflare `cloudflared`, only for remote phone access to the local Supabase API.

The project currently runs with Node 20.17 and Next.js 16. The normal application checks pass on that setup.

## First-time setup

From the project directory:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env.local
```

For local-only development, use the values printed by `supabase status`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<local-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key>
```

Never commit `.env.local`. It is ignored by `.gitignore`. Service-role keys and model/storage secrets must never be sent to the browser.

## Start local Supabase

Start Docker Desktop first, then run:

```bash
supabase start
```

If a service health check is slow during the first image download:

```bash
supabase start --ignore-health-check
```

Inspect local URLs and keys:

```bash
supabase status
```

Important local services:

| Service | URL/port | Purpose |
|---|---|---|
| Supabase API | `http://127.0.0.1:54321` | Auth, REST, Storage, Realtime gateway |
| Postgres | `127.0.0.1:54322` | Database connection |
| Studio | `http://127.0.0.1:54323` | Local database UI |
| Inbucket | `http://127.0.0.1:54324` | Local email viewer |

Apply new migrations without deleting local data:

```bash
supabase db push --local --yes
```

Check the local migration history:

```bash
supabase migration list --local
```

Lint the database schema:

```bash
supabase db lint --local --level error --fail-on error
```

Stop local Supabase while preserving its Docker volume:

```bash
supabase stop
```

Do not use `supabase stop --no-backup` casually. It deletes local database volumes.

## Start the Next.js app

The repository includes repeatable mode scripts:

```bash
./scripts/run-local.sh
```

This starts local Supabase if needed and runs Next.js at `http://localhost:3000`.

For remote phone testing from another network:

```bash
./scripts/run-remote-test.sh
```

This starts local Supabase, creates a Cloudflare tunnel for the Supabase API, creates an ngrok tunnel for Next.js, prints the phone URL, and runs the app with the temporary Supabase URL. Keep that shell open while testing.

Stop only the app/tunnels with Ctrl+C. Stop the complete Deacon stack with:

```bash
./scripts/stop-all.sh
```

Check whether anything remains active:

```bash
./scripts/status.sh
```

The status script checks the Next.js listener, Supabase API listener, ngrok, Cloudflare Tunnel, and the Supabase database container. It exits with `0` when everything is stopped and `1` when something is still running.

For normal computer-only development:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To make the app listen on all local interfaces, which is needed for LAN or tunnel testing:

```bash
npm run dev -- --hostname 0.0.0.0 --port 3000
```

The app routes are:

| Route | Purpose |
|---|---|
| `/` | Public landing page |
| `/login` | Email/password sign-in and account creation |
| `/library` | Protected library and image upload panel |
| `/search` | Protected search placeholder |
| `/api/auth/password` | Same-origin sign-in/account creation route |
| `/api/sessions` | Creates an upload session |
| `/api/uploads/prepare` | Validates an image and creates a `media_items` row |
| `/api/uploads/complete` | Verifies Storage and moves the item to `processing` |
| `/auth/callback` | Legacy auth callback route; not used by the current password flow |

## Application checks

Run all checks before committing:

```bash
npm run typecheck
npm run lint
npm run build
```

Or run them sequentially in one command:

```bash
npm run typecheck && npm run lint && npm run build
```

The production build should list the app, auth, library, search, and upload API routes without errors.

## Authentication

The current MVP uses Supabase email/password authentication. The email address is the username; arbitrary usernames are deferred.

The signup trigger creates a matching `public.users` profile row whenever a user is created in `auth.users`.

For local development, email confirmation is disabled in `supabase/config.toml`, so a newly created local account can sign in immediately. A production Supabase project must be configured separately for email confirmation, password policy, and SMTP.

The login form contains visible diagnostics. Tap **Check again** to test Supabase Auth from the current device. It reports:

- whether the public Supabase URL is configured;
- whether the Auth health endpoint is reachable;
- the last authentication step;
- a safe error message without exposing tokens.

The password route uses a same-origin server endpoint so the session cookie is set by the application before navigating to `/library`. It also has a no-JavaScript form fallback.

## Phase 2 upload flow

The current upload flow handles one image at a time:

1. The user taps **Add** and selects a JPEG, PNG, or HEIC image.
2. The browser computes a SHA-256 hash.
3. The app creates one session automatically using today’s date.
4. The server checks for an existing exact hash.
5. The server creates a `media_items` row with `status=uploading`.
6. The browser uploads directly to the private Supabase Storage `media` bucket.
7. The server verifies the object and changes the row to `status=processing`.
8. The library renders a signed preview URL.

Local development uses Supabase Storage behind the storage boundary. Production will use Cloudflare R2 and presigned multipart uploads without changing the core session/media API.

Storage keys use this shape:

```text
users/{user_id}/{media_id}/original.{ext}
```

The Storage policies only allow an authenticated user to access objects under their own `users/{user_id}/` prefix.

## Testing from a phone on another network

The phone does not need to share Wi-Fi with the computer, but two temporary HTTPS tunnels are required:

1. One tunnel for Next.js on port `3000`.
2. One tunnel for the local Supabase API on port `54321`.

Start the app first:

```bash
npm run dev -- --hostname 0.0.0.0 --port 3000
```

Start the app tunnel in another terminal:

```bash
ngrok http 3000
```

Copy the generated HTTPS app URL. Then start the Supabase API tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:54321
```

Copy the generated Cloudflare HTTPS URL. Update `.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<cloudflare-supabase-url>
```

Update `supabase/config.toml` so Auth allows the ngrok app URL:

```toml
site_url = "https://<ngrok-app-url>"
additional_redirect_urls = [
  "https://<ngrok-app-url>",
]
```

Restart Supabase after changing Auth URLs:

```bash
supabase stop
supabase start --ignore-health-check
```

Restart Next.js after changing `.env.local`:

```bash
npm run dev -- --hostname 0.0.0.0 --port 3000
```

Open the ngrok app URL on the phone. Temporary tunnel URLs change when the tunnel process is restarted and should never be treated as production URLs.

The current setup intentionally does not expose Inbucket publicly because it contains magic-link emails and session material. Password authentication avoids needing that extra tunnel.

## Useful diagnostics

Check whether the app is listening:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

Check whether Supabase is listening:

```bash
lsof -nP -iTCP:54321 -sTCP:LISTEN
```

Check Supabase Auth locally:

```bash
node -e 'fetch("http://127.0.0.1:54321/auth/v1/health").then(async r => console.log(r.status, await r.text()))'
```

Check the public app URL without exposing credentials:

```bash
node -e 'fetch("https://<ngrok-app-url>/").then(async r => console.log(r.status, (await r.text()).length))'
```

The ngrok request inspector is available locally at [http://127.0.0.1:4040](http://127.0.0.1:4040). It is useful for checking whether the phone reached `/api/auth/password`, `/library`, or the upload endpoints.

If the phone shows `0.0.0.0:3000/library`, it is using an old redirect. Open a fresh tab using the current ngrok URL. The form fallback now uses a relative `/library` redirect and will stay on the public host.

If ngrok shows `ERR_NGROK_3200`, the tunnel process is offline. Restart:

```bash
ngrok http 3000
```

If the public app loads but Supabase diagnostics say unreachable, restart the Cloudflare tunnel and update `NEXT_PUBLIC_SUPABASE_URL` to its new URL, then restart Next.js.

## Git workflow

Check what will be committed:

```bash
git status
git diff --stat
git diff --cached --stat
```

Stage the complete working tree:

```bash
git add -A
```

Review staged files and secrets before committing:

```bash
git diff --cached --name-status
git diff --cached -- .env.example README.md
```

Create a commit:

```bash
git commit -m "Build Deacon MVP foundation and image upload"
```

`.env.local`, `.next`, `node_modules`, and Supabase temporary state are ignored. Never commit passwords, API keys, service-role keys, or temporary tunnel credentials.

## Next implementation steps

Follow the phases in [masterclass-kb-build-spec.md](masterclass-kb-build-spec.md):

1. Image processing: thumbnail, OCR, vision description, CLIP fingerprint, and `ready` status.
2. Video processing: ffmpeg audio extraction, Whisper transcript, full transcript storage, timestamped chunks, poster frame, and download.
3. Search and chat over multilingual text chunks.
4. Image and video deduplication UI.
5. Notes, channels, unsorted sessions, soft deletion, purge, retries, and hardening.
