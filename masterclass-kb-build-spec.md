# MasterClass KB — Build Spec & MVP Development Plan

**Status:** Draft for engineering handoff · companion to `masterclass-kb-mvp-spec.md` (the design/why)
**This doc:** the *how* and the *build order*. It specifies decisions concretely so engineers don't have to ask. Anything marked **[OVERRIDABLE]** is a default we can change — everything else, treat as decided.
**Last updated:** July 12, 2026

---

## A. Committed technical decisions

Concrete picks so nobody has to guess. All **[OVERRIDABLE]** unless noted.

| Concern | Decision |
|---|---|
| Frontend framework | Next.js on Vercel (provided by product owner) |
| DB | Postgres via Supabase, `pgvector` enabled |
| Object storage | Cloudflare R2 (S3-compatible API) |
| Auth | Supabase Auth — **email + password** credentials for MVP |
| Job queue | Inngest |
| Transcription | OpenAI Whisper (`whisper-1`) — auto language detect |
| Text embeddings | `text-embedding-3-small` (1536-dim, multilingual) — **fixed for MVP** (changing later means re-embedding) |
| Image dedup embedding | CLIP ViT-B/32 (512-dim) |
| Image OCR + description | Vision LLM (single call returns both), Spanish-capable |
| Chat LLM | Any strong general model; must answer in the user's language |
| PDF transcript export | Server-side render (e.g. a headless HTML→PDF lib) |
| Deletion | Soft delete (`deleted_at`) + background purge after 30 days |
| Live status | Supabase Realtime (row subscription), polling fallback |

---

## B. Auth & session

**Provider:** Supabase Auth. Email + password is the MVP credential flow. The email address is the username; arbitrary usernames are deferred.

**Flow:**
1. User enters email and password → Supabase creates or verifies the account → returns a session (JWT access + refresh token), stored by the Supabase client.
2. The JWT carries `auth.uid()` — the Postgres identity every RLS policy keys on.
3. Frontend attaches the access token to every backend call (`Authorization: Bearer <jwt>`); the backend validates it and derives `user_id`.

**Profile row sync:** a Postgres trigger on `auth.users` inserts a matching `public.users` row on signup (so app tables can FK to it). Provide as a migration:
```sql
create function public.handle_new_user() returns trigger as $$
begin
  insert into public.users (id, email, created_at)
  values (new.id, new.email, now());
  return new;
end; $$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

**Responsibilities:** login UI + token storage = frontend (Supabase client SDK). Token validation + `user_id` derivation on every request = backend.

---

## C. Row-level security (RLS)

**Rule:** RLS is enabled on every app table, and the DB is the enforcement point — not application code.

**Enable + policy pattern** (repeat per table; `media_items` shown):
```sql
alter table media_items enable row level security;

create policy "own rows - select" on media_items
  for select using (user_id = auth.uid());
create policy "own rows - modify" on media_items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```
Apply to: `channels`, `sessions`, `media_items`, `notes`, `text_chunks`, `transcripts`, `duplicate_flags`, `chat_messages`. `users` gets a self-only select policy.

**Vector search must still filter explicitly.** RLS covers row access, but the similarity query should include `where user_id = auth.uid()` so the index is used and scoping is unambiguous.

**R2 is NOT covered by RLS.** Files live outside Postgres. File isolation works like this: the backend, before signing any R2 URL (upload or download), looks up the `media_items` row and confirms `user_id = auth.uid()`. Only then does it issue a **short-lived** (e.g. 5-minute) signed URL for that specific object. No public buckets, ever.

---

## D. Storage & media serving

**R2 key layout:** `users/{user_id}/{media_id}/original.{ext}`, thumbnails at `users/{user_id}/{media_id}/thumb.jpg`, video poster at `.../poster.jpg`.

**New `media_items` fields this requires:**
| Field | Type | Notes |
|---|---|---|
| thumbnail_key | string | grid thumbnail (image thumb / video poster) |
| duration_ms | int | video only |
| width, height | int | for layout |
| deleted_at | timestamp | soft delete (null = live) |

**Thumbnails:** generated during processing (image → downscaled JPEG; video → a poster frame via ffmpeg), uploaded to R2, key stored on the row.

**Serving images:** backend endpoint verifies ownership, returns a signed GET URL; frontend `<img>` loads it.

**Video playback:** backend returns a signed URL; the native `<video>` element streams from R2 using **HTTP range requests** (R2 supports them), which is what makes scrubbing work. **Seek-to-timestamp:** the player accepts a `t` param (ms); on load it sets `video.currentTime = t/1000`. This is how a search result lands on 12:43.

**HEVC caveat:** HEVC `.mov` plays inconsistently in browsers. If in-app rewatch is required (open thread §14 of design doc), a processing step transcodes to H.264/MP4 and stores that as the playback key; otherwise we store original and accept that some devices won't play it in-browser.

---

## E. API contract

**Conventions:**
- All endpoints require `Authorization: Bearer <jwt>` unless noted. `user_id` is always derived server-side — never trusted from the body.
- JSON in/out. Errors: `{ "error": { "code": "...", "message": "..." } }` with standard HTTP status (400 validation, 401 auth, 403 not-owner, 404, 409 conflict, 429 rate-limit, 500).
- List endpoints paginate: `?limit=&cursor=`, return `{ items: [...], next_cursor }`.
- Mutating upload endpoints are idempotent on `file_hash` (safe retries).

**Upload**
| Method · Path | Purpose | Request → Response |
|---|---|---|
| POST `/api/uploads/presign` | Exact-dup check + start upload | `{file_hash, filename, mime, size, session_id?}` → either `{duplicate:true, existing:[{media_id, thumbnail_url}]}` or `{duplicate:false, media_id, upload:{uploadId, key, partUrls[]}}` |
| POST `/api/uploads/complete` | Finalize multipart, run image similarity | `{media_id, parts:[{PartNumber, ETag}]}` → `{status:"processing"}` or `{similar:[{media_id, thumbnail_url}]}` (pending user confirm) |
| POST `/api/uploads/:media_id/confirm` | User chose "add anyway" or "skip" | `{keep:true|false}` → `{status}` (on skip, R2 object deleted) |

**Sessions & channels**
| Method · Path | Purpose |
|---|---|
| GET `/api/sessions` | List (filters: `channel_id`, `unsorted=true`, date range) |
| GET `/api/sessions/:id` | Session + its media, notes, statuses |
| PATCH `/api/sessions/:id` | Rename, set `session_date`, assign `channel_id` |
| DELETE `/api/sessions/:id` | Soft-delete (cascades, §I) |
| GET/POST `/api/channels` · PATCH/DELETE `/api/channels/:id` | Channel CRUD |

**Media, notes, transcript**
| Method · Path | Purpose |
|---|---|
| GET `/api/media/:id` | Metadata + signed display/playback URL |
| DELETE `/api/media/:id` | Soft-delete one item |
| GET `/api/media/:id/transcript` | Full transcript text + language |
| GET `/api/media/:id/transcript/download?format=pdf\|txt` | Downloadable transcript |
| POST `/api/notes` · PATCH/DELETE `/api/notes/:id` | Note CRUD (edit re-embeds) |

**Search & chat**
| Method · Path | Purpose → Response |
|---|---|
| GET `/api/search?q=` | Vector search over `text_chunks`, user-scoped → `{results:[{source_type, session_id, media_id?, note_id?, snippet, start_ms?, char_start?, thumbnail_url?, score}]}` — each result carries the locator to land precisely |
| POST `/api/chat` | RAG answer (streamed) → text + `citations:[{source_type, media_id?, note_id?, start_ms?}]` |

**Duplicates**
| Method · Path | Purpose |
|---|---|
| GET `/api/duplicates` | Open `duplicate_flags` for the library badges |
| POST `/api/duplicates/:id/resolve` | `{action:"dismiss"\|"delete_newer"}` |

---

## F. Processing pipeline (implementation)

Orchestrated by Inngest; one function per media item, fanned into steps. Every step is **idempotent** (safe to retry) and keyed on `media_id` so re-runs don't duplicate chunks.

**Status machine on `media_items.status`:** `uploading → processing → ready` (or `→ failed`). Each step updates status/progress; the row is the single source of truth the UI subscribes to.

**Video job:**
1. Extract audio (ffmpeg) from the `.mov`.
2. Transcribe (Whisper) → returns segments with timestamps + detected language.
3. Store full transcript in `transcripts` (with `language`).
4. Chunking (**baseline, [OVERRIDABLE]**): group segments into ~3-sentence rolling windows with 1-sentence overlap; each chunk keeps the **tight** `start_ms`/`end_ms` of its first→last segment.
5. Embed each chunk (`text-embedding-3-small`) → insert into `text_chunks` (`source_type=transcript`).
6. Generate poster frame → R2 → `thumbnail_key`.
7. (Background, low priority) keyframe fingerprint → compare → write `duplicate_flags` on match.

**Image job:**
1. If arrived HEIC → convert to JPEG.
2. Vision LLM call → returns OCR text + a description. Store as two chunks (`image_ocr`, `image_vision`), embed each.
3. CLIP embedding (512-dim) → `media_items.clip_embedding` (also computed in the fast lane for dedup; store here canonically).
4. Downscaled thumbnail → R2 → `thumbnail_key`.

**Note job:** sentence-segment → same rolling-window chunking → embed (`source_type=note`), storing `char_start`/`char_end`. Re-runs on edit (delete old chunks for that note, re-insert).

**Retries:** Inngest auto-retries failed steps (backoff). After max retries, set `status=failed` with an error reason; UI shows a friendly "couldn't finish — retry?" with a retry action that re-enqueues.

---

## G. Search & chat (implementation)

**Search:** embed the query with the same model → `pgvector` cosine top-k (e.g. k=30) `where user_id = auth.uid() and deleted_at is null` → group/rank by score → return each hit with its locator (`start_ms` for transcript → deep-link to video; `media_id` for image → screenshot; `char_start` for note → highlight). No LLM call.

**Chat (RAG):** embed the question → retrieve top-k chunks (user-scoped) → build a prompt with the retrieved snippets + their source ids → LLM generates a **streamed** answer that cites sources → frontend renders citations as tappable links that open the exact screenshot or seek the video. System prompt instructs: answer only from provided context, say when unknown, reply in the user's language.

**Chat history (minimal):** `chat_messages` table `{id, user_id, role, content, citations jsonb, created_at}` so a conversation persists. **[OVERRIDABLE]** — can be ephemeral for MVP.

---

## H. Dedup (implementation)

**Tier 1 (upload-time):**
- Exact: `presign` compares `file_hash` against existing rows → immediate duplicate response, no upload.
- Image near/visual: on `complete`, compute pHash + CLIP, query for matches above threshold → return `similar[]` → frontend shows the "add anyway?" dialog → `confirm` keeps or deletes.
- **Starting thresholds [OVERRIDABLE]:** pHash Hamming distance ≤ 6; CLIP cosine ≥ 0.92. Tune with real data.

**Tier 2 (library-time, video):** background keyframe fingerprint compare → write `duplicate_flags(status=open, confidence)` → library shows a badge → user resolves via `/api/duplicates/:id/resolve`. Never auto-deletes.

---

## I. Library, notes, editing, deletion

**Library views:** All (reverse-chronological timeline), By channel, Unsorted (`channel_id is null`), and Session detail (media grid + notes + statuses). Each media tile shows thumbnail, status badge ("getting ready"/ready/failed), and any duplicate badge.

**Notes:** created/edited/deleted against a session; any create/edit enqueues the note job to re-chunk and re-embed so search stays current.

**Editing:** rename session, set date, assign/clear channel — all `PATCH /sessions/:id`, all cheap (re-point links, no data movement).

**Deletion (soft + cascade + purge):**
- `DELETE /sessions/:id` sets `deleted_at` on the session and all its media/notes; hides them from every list and from search/chat (all queries filter `deleted_at is null`).
- A daily background purge job hard-deletes rows past 30 days **and** removes their R2 objects (originals + thumbnails) and their `text_chunks`, `transcripts`, `duplicate_flags`.
- This gives a non-technical user an "undo window" and guarantees no orphaned files or embeddings.

---

## J. Status, realtime, errors

- **Realtime:** frontend subscribes (Supabase Realtime) to its `media_items` rows; status changes push live, so "getting ready" → "ready" needs no refresh. Polling `GET /media/:id` is the fallback.
- **Upload errors:** resumable multipart means a dropped connection resumes; surface a retry button.
- **Processing errors:** `status=failed` + reason → friendly retry action.
- **Partial batches:** each item processes independently; one failure never blocks the others or the session.

---

## K. Limits, validation, cost

**Validation / limits [OVERRIDABLE]:**
- Allowed mime: `image/jpeg`, `image/png`, `image/heic`, `video/mp4`, `video/quicktime`.
- Max image 50 MB; max video 5 GB; max 50 files per batch.
- Rate-limit `presign` (e.g. 100/min/user) to prevent abuse.
- Validate declared mime/size against the actual object after upload.

**Cost model (rough, per month — VERIFY current provider pricing at build):**
| Item | Estimate |
|---|---|
| R2 storage (100 GB) | ~$1.50 |
| R2 egress | $0 (free egress) |
| Transcription | ~$0.36 per 1-hr class |
| Embeddings | fractions of a cent per class |
| Vision (per screenshot) | ~1–2 cents |
| Chat (per question) | ~1–3 cents |
| Supabase + Vercel + Inngest | ~$0–50 depending on tier |

Storage is trivial; the variable cost is transcription + vision, scaling with how much she uploads. Comfortably low for a single user.

---

## L. Environment & config

Services to provision: Supabase project (DB + Auth + Realtime), R2 bucket + API token, Vercel project, Inngest app, API keys (Whisper/embeddings/vision/chat provider).

Env vars (server): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `INNGEST_SIGNING_KEY`, `OPENAI_API_KEY` (or per-provider keys), `LLM_API_KEY`. All secrets server-side only; never shipped to the client.

---

## M. Data-model deltas introduced by this spec

Add to the design doc's model:
- `media_items`: `thumbnail_key`, `duration_ms`, `width`, `height`, `deleted_at`.
- `sessions`, `notes`: `deleted_at`.
- New table `chat_messages` (optional, §G).
- Confirm `text_chunks` locator fields (`start_ms`,`end_ms`,`char_start`,`char_end`) and `transcripts` table exist (already in design doc).

---

## N. Step-by-step MVP build plan

Each phase has an **acceptance check** — done when it passes. Build the thin thread first (phases 0–4), then widen.

**Phase 0 — Infrastructure.** Provision Supabase, R2, Vercel, Inngest. Write initial migrations: all tables, `pgvector`, RLS policies, the `handle_new_user` trigger. *Accept:* migrations run clean; RLS on; a seeded row is invisible to a different user.

**Phase 1 — Auth.** Email/password account creation and sign-in; profile-row sync; token flows end to end. *Accept:* user creates an account, signs in, `users` row exists, and an authenticated call returns only that user's (empty) data.

**Phase 2 — Walking-skeleton upload.** `presign → direct-to-R2 (AwsS3Multipart) → complete`. One image, no dedup, no processing yet. *Accept:* a picked image lands in R2 under the right key; a `media_items` row exists with `status=uploading→processing`.

**Phase 3 — Processing (image).** Inngest function: image → vision (OCR+description) → embed → CLIP → thumbnail → `status=ready`. Realtime status updates. *Accept:* uploaded image flips to "ready" live; `text_chunks` + thumbnail exist.

**Phase 4 — Display & library.** Signed URLs, thumbnails, library grid, session detail. *Accept:* the image appears in the library and opens full-size; nothing else's data is visible.

**Phase 5 — Video path.** Audio extract → Whisper → `transcripts` + timestamped `text_chunks` → poster thumbnail → player with `t` seek. *Accept:* a class video transcribes; transcript is downloadable (pdf/txt); player seeks to a given ms.

**Phase 6 — Search & chat.** Search endpoint with precise landing; RAG chat with streamed cited answers. *Accept:* a query returns a screenshot **and** a transcript moment; clicking the transcript hit seeks the video; chat answers cite real sources; a Spanish query over Spanish content works.

**Phase 7 — Dedup.** Tier 1 exact + image similarity dialog; Tier 2 background video flagging + library badge. *Accept:* re-uploading the same file triggers the dialog; a near-duplicate screenshot is offered "add anyway?"; a duplicate video gets a badge.

**Phase 8 — Management.** Notes CRUD (with re-embed), session rename/date/channel assign, Unsorted view + assign, soft-delete + cascade + purge. *Accept:* editing a note updates search; assigning a channel moves a session out of Unsorted; deleting a session hides it everywhere and (after purge) removes R2 objects + chunks.

**Phase 9 — Hardening.** Error/retry surfaces, empty states, limits/validation/rate-limits, cost guardrails. *Accept:* a forced job failure shows a retry; oversized/blocked file is rejected cleanly.

---

## O. End-to-end test script

Run this whole thread as the MVP acceptance test (happy path + the key edges):

1. **Create an account and sign in** with email + password → land in an empty library.
2. **Upload a batch** from the iPad Photos picker: one class recording + several screenshots, selected together.
3. Confirm the **date prompt** appears once for the batch, pre-filled; accept it. The batch becomes one **session**, shown as "getting ready."
4. Watch statuses flip to **ready** live (no refresh) as processing completes.
5. Open the session: screenshots show as thumbnails; open one full-size; **play the video** and scrub.
6. **Search** for a term you know is spoken in the class → result lands on the **transcript moment**; click it → video **seeks to that second**. Search a term on a slide → lands on the **screenshot**.
7. Run the same in **Spanish** over Spanish content → works.
8. **Chat**: ask a question about the class → streamed answer with **citations** that open the right screenshot / seek the video.
9. **Download the transcript** as PDF and as text.
10. **Re-upload** the same screenshot → "add anyway?" dialog appears; skip it → not added. Upload a **near-duplicate** → dialog appears; add anyway → added.
11. A **duplicate video** later shows a "possible duplicate" **badge** in the library; resolve it.
12. **Assign** the (unsorted) session to a new **channel**; confirm it leaves Unsorted.
13. **Add and edit a note**; confirm the edit is findable in search.
14. **Delete** the session → disappears from library, search, and chat immediately; after purge, its R2 files and chunks are gone.
15. **Isolation check:** a second user sees none of the above.

Passing 1–15 = MVP done.
