# Deacon production runbook

This is the release checklist for giving the dermatologist a link. The web app and media worker are separate services.

## 1. Hosted Supabase

Create or select the production Supabase project, then apply every migration:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Confirm the production project has:

- Auth email/password enabled;
- the private `media` Storage bucket;
- the storage policies from `20260712010000_media_storage.sql`;
- pgvector enabled;
- production redirect URLs for the final HTTPS app URL.

## 2. Web application

Deploy the repository as a Next.js application. Set these variables in the web deployment:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<supabase-service-role-key>
OPENAI_API_KEY=<restricted-key-with-model-request>
OPENAI_VISION_MODEL=gpt-5.6-luna
OPENAI_VISION_DETAIL=low
RESEND_API_KEY=<Resend API key for support alerts>
RESEND_FROM_EMAIL=Deacon <alerts@hugmun.ai>
NEXT_PUBLIC_BASE_PATH=/deacon
APP_PUBLIC_URL=https://www.hugmun.ai/deacon
MCP_PUBLIC_URL=https://www.hugmun.ai/deacon/mcp
MCP_OAUTH_ISSUER=https://www.hugmun.ai/deacon
MCP_OAUTH_SIGNING_SECRET=<long-random-secret>
MCP_OAUTH_REDIRECT_PREFIX=https://chatgpt.com/connector/oauth/
```

Do not expose `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, or `MCP_OAUTH_SIGNING_SECRET` as `NEXT_PUBLIC_*` variables.

`RESEND_FROM_EMAIL` must be a sender verified in Resend. The worker uses these two variables to send processing-failure details to `hello@hugmun.ai`; missing or broken email configuration must not block uploads, but it will be logged as an operational issue.

## 3. Media worker

Deploy [`Dockerfile.worker`](Dockerfile.worker) as an always-on worker. It includes `pdftotext` for transcript/PDF processing and `ffmpeg` for video audio extraction; video items are only processed by workers that have ffmpeg (the Vercel lane skips them).

Recommended host: **Railway** (deploys from GitHub, no CLI required, needs no inbound networking):

1. railway.com → New Project → **Deploy from GitHub repo** → select `hug-mun/deacon`.
2. Railway reads [`railway.json`](railway.json) and builds `Dockerfile.worker` automatically.
3. In the service **Variables** tab, add the worker variables below, then deploy.
4. Confirm the deploy logs show `[deacon][worker] started` and `/api/health` reports `media_worker` as `ok`.

The worker only polls Supabase outbound, so do not add a public domain to the service.

Set the worker variables:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<supabase-service-role-key>
OPENAI_API_KEY=<same-openai-key-as-web>
OPENAI_VISION_MODEL=gpt-5.6-luna
RESEND_API_KEY=<Resend API key for support alerts>
RESEND_FROM_EMAIL=Deacon <alerts@hugmun.ai>
WORKER_INSTANCE_ID=deacon-worker-production-1
```

The worker must be running before uploads are accepted. Its heartbeat is visible in `/api/health` and the authenticated library diagnostics.

## 4. `hugmun.ai/deacon` routing

The existing `https://www.hugmun.ai/` site must route `/deacon/*` to the Deacon deployment. If the sites are separate Vercel projects, add an external rewrite in the hugmun.ai project using the Deacon deployment URL, preserving the `/deacon` path. If that project cannot add a cross-project rewrite, use `https://deacon.hugmun.ai` instead and change the public URL variables accordingly.

## 5. Acceptance test

Before sharing the link:

1. Open `https://www.hugmun.ai/deacon/api/health?deep=1`; it must return HTTP 200 and show `app`, `supabase_database`, `supabase_storage`, `media_worker`, `openai_api`, `openai_vision`, and `mcp`.
2. Create a test account and open the library from an iPad Safari session.
3. Tap **Revisar IA**; `openai_vision` must be `ok`, not `missing_scope`.
4. Upload one JPG/PNG, one HEIC image, and one PDF transcript.
5. Confirm all three reach `Lista`, then search for visible slide text and a transcript phrase.
6. Connect ChatGPT to `https://www.hugmun.ai/deacon/mcp` and verify OAuth discovery, `search_knowledge`, `get_media_item`, and bounded `get_transcript` retrieval.
7. Confirm the library exposes retry/delete actions for a failed item and that the delete confirmation sends content to the 30-day recycle bin. Do not exhaust production credits to test this; use a local/mocked provider failure.
8. Remove the test account and test files.

## 6. Ongoing monitoring

Monitor `/api/health` every 1–5 minutes. Investigate immediately when:

- HTTP 503 is returned;
- `media_worker` is `down` or its heartbeat is older than 90 seconds;
- the library shows `openai_vision` permission or quota errors;
- the library shows `embedding_quota_exhausted`, `embedding_permission_denied`, or repeated `processing_failed` items;
- worker logs report `support email not configured` or `support email failed`;
- uploaded files remain in `processing` for more than a few minutes.

Before uploading any material that could identify a patient, confirm that the material is de-identified and that the production storage, model provider, and organizational policies are appropriate for that material.
