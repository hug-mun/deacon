# Deacon

Deacon is a private knowledge base for master classes. The MVP is designed for an iPad-first web experience where recordings, screenshots, and notes become searchable and available to grounded chat.

The current implementation has:

- Next.js on Vercel-style hosting;
- local Supabase Auth, Postgres, pgvector, Realtime, and Storage;
- email/password authentication;
- RLS-protected user data;
- PDF and image upload with exact duplicate protection;
- AI image understanding that extracts visible text, visual descriptions, anatomy, and study keywords into searchable chunks;
- asynchronous PDF text extraction, transcript reading, and progress polling;
- lexical transcript search that works without an embedding provider, plus optional vector/hybrid ranking;
- transcript text download and a retry action for failed processing;
- service diagnostics at `/api/diagnostics`, including a deliberate deep vision probe;
- a local read-only MCP endpoint at `/mcp` with knowledge search, library listing, media inspection, and bounded transcript-reading tools;
- temporary remote phone testing through ngrok and Cloudflare Tunnel.
- a production-ready worker container with PDF extraction and service heartbeats.

Read the system design in [architecture.md](architecture.md), the product design in [masterclass-kb-mvp-spec.md](masterclass-kb-mvp-spec.md), the build plan in [masterclass-kb-build-spec.md](masterclass-kb-build-spec.md), and the [production runbook](production-runbook.md).

## Current status

Completed:

1. Phase 0 — project scaffold, Supabase schema, pgvector, RLS, and profile trigger.
2. Phase 1 — email/password account creation, sign-in, protected routes, and sign-out.
3. Phase 2 — PDF/image selection, automatic session creation, SHA-256 exact-duplicate check, direct Storage upload, finalization, and library preview.
4. PDF processing foundation — text extraction, durable chunks, full transcript reader/download, progress reporting, and retry endpoint.
5. Retrieval foundation — PostgreSQL full-text search works without embeddings; vector retrieval is an optional second signal for hybrid results.

Next:

- Phase 3: image thumbnails, CLIP fingerprinting, and richer visual duplicate detection.
- Phase 5: video upload, audio extraction, Whisper transcription, timestamped chunks, and playback derivatives.
- Production hosting: deploy with `NEXT_PUBLIC_BASE_PATH=/deacon` behind `https://www.hugmun.ai/deacon`.

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
| `/forgot-password` | Requests a password reset email |
| `/reset-password` | Sets a new password from a valid reset link |
| `/library` | Protected library and upload panel |
| `/search` | Protected search surface |
| `/api/auth/password` | Same-origin sign-in/account creation route |
| `/api/sessions` | Creates an upload session |
| `/api/uploads/prepare` | Validates a PDF/image and creates a `media_items` row |
| `/api/uploads/complete` | Verifies Storage and moves the item to `processing` |
| `/mcp` | Streamable HTTP MCP endpoint for read-only knowledge access (`search_knowledge`, `list_library`, `get_media_item`, `get_transcript`) |
| `/api/health` | Public uptime/readiness status for app, storage, worker, OpenAI configuration, and MCP |
| `/api/diagnostics` | Authenticated service-by-service health checks |
| `/auth/callback` | Legacy auth callback route; not used by the current password flow |

## Application checks

Run all checks before committing:

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run test:e2e

# Authenticated upload → storage → worker → status test (local, real image)
DEACON_TEST_IMAGE_PATH=/absolute/path/to/study.png npm run test:pipeline
```

Or run them sequentially in one command:

```bash
npm run typecheck && npm run lint && npm run build
```

The production build should list the app, auth, library, search, and upload API routes without errors.

`npm run test:e2e` checks the public route contract and authentication boundaries against the running app. It does not create user data. `Revisar IA` in the library calls a one-pixel, low-detail vision request so a missing key permission, exhausted credit, or provider outage is identified as a named service failure. The deep probe is intentionally manual because it makes a real provider request.

`npm run test:pipeline` creates and removes a temporary local user, uploads the supplied image through the same API and private Storage path as the browser, starts the worker, and waits for a terminal processing status. It accepts either a successful image index or the expected, explicitly classified vision-permission failure.

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

## Local upload processing

`./scripts/run-local.sh` starts the Next.js app and a separate media worker. The worker watches `media_items.status=processing`, extracts text from PDFs with `pdftotext`, stores the transcript and searchable text chunks, and moves the item to `ready`. Progress is stored on the media row and the library polls it every 1.5 seconds. Leaving the library page does not stop the worker; it continues until the local app is stopped.

The worker always creates transcript chunks. If `OPENAI_API_KEY` is absent, PostgreSQL full-text search remains available for PDFs and notes. If the key is present, the worker backfills `text-embedding-3-small` vectors and the search API combines lexical and vector results. Images use the configured `OPENAI_VISION_MODEL` (default `gpt-5.6-luna`) to extract visible text and a searchable visual description before embedding both.

The image lane requires an API key with the `model.request` permission in addition to embeddings access. A restricted key that can call `/v1/embeddings` but cannot call a vision model will leave image items in a failed state with a permission-specific message.

Every media processing failure records the responsible service, a safe user-facing explanation, and—when the provider supplies one—the request ID. The library shows these details and the retry action. The boundaries are `supabase_database`, `supabase_storage`, `openai_vision`, `openai_embeddings`, `media_worker`, and `mcp`; this keeps the MVP operationally diagnosable without splitting the deployment into unnecessary network microservices.

The MCP implementation includes OAuth 2.1 discovery, authorization-code + PKCE, and audience-bound access tokens. Production still requires the HTTPS deployment variables and a long random `MCP_OAUTH_SIGNING_SECRET`; the MCP retrieval path uses the same hybrid lexical/semantic search as the web app when embeddings are available.

The worker writes its logs to `.deacon-worker.log`. To run it separately:

```bash
npm run worker:media
```

## Upload flow

The current upload flow handles one PDF or image at a time:

1. The user taps **Add** and selects a PDF, JPEG, PNG, or HEIC image.
2. The browser computes a SHA-256 hash.
3. The app creates one session automatically using today’s date.
4. The server checks for an existing exact hash.
5. The server creates a `media_items` row with `status=uploading`.
6. The browser uploads directly to the private Supabase Storage `media` bucket.
7. The server verifies the object and changes the row to `status=processing`.
8. The library renders a signed preview URL or the full-width PDF transcript reader.

Local development uses Supabase Storage behind the storage boundary. Production will use Cloudflare R2 and presigned multipart uploads without changing the core session/media API.

Storage keys use this shape:

```text
users/{user_id}/{media_id}/original.{ext}
```

## HTTPS and `/deacon`

`https://www.hugmun.ai/` is already served by Vercel with HTTPS. This repository supports a path-mounted deployment by building with:

```dotenv
NEXT_PUBLIC_BASE_PATH=/deacon
APP_PUBLIC_URL=https://www.hugmun.ai/deacon
MCP_PUBLIC_URL=https://www.hugmun.ai/deacon/mcp
MCP_OAUTH_ISSUER=https://www.hugmun.ai/deacon
```

The existing hugmun.ai Vercel project must then route `/deacon/*` to the Deacon deployment, or both sites must be combined into one Vercel project. A separate `deacon.hugmun.ai` deployment is the simpler fallback if the current Astro project cannot add a cross-project rewrite. OAuth metadata and client-side API calls are base-path aware.

The web deployment and media worker are separate runtime responsibilities. Deploy `Dockerfile.worker` to a small always-on container service with the same Supabase and OpenAI environment variables. The worker must remain running; `/api/health` reports `media_worker: down` when its heartbeat is older than 90 seconds. The production web app should be monitored at `/api/health`, and the authenticated library diagnostics should be used for human-readable incident details.

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
