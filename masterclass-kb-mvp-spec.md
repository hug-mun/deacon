# MasterClass Knowledge Base — MVP Technical Design

**Status:** Draft (MVP scope) · living document, iterating before engineering handoff
**Last updated:** July 12, 2026

---

## 1. What we're building

A private, per-user knowledge base for master classes. A user watches and records a class, takes screenshots of the moments that matter, and writes notes. All of that gets stored, deduplicated, and made searchable — and a chat lets her ask questions about everything she's captured ("what did the instructor say about X?") and get answers grounded in her own material.

Three capabilities sit on top of storage: a **deduplication gate** so the same photo or video isn't stored twice, **search** that lands precisely on the matching transcript moment / screenshot / note, and a **RAG chat** that answers questions using her transcripts, notes, and screenshots. Content is often in Spanish, so the whole pipeline is multilingual.

---

## 2. Who it's for (and the one rule that follows)

The primary user is a **single, non-technical person**, capturing primarily from an **iPad Pro**. Everything below bends toward one principle:

> **The user inputs the absolute minimum.** We extract, infer, and default wherever possible. We never block an upload behind a form. Organization is optional and always deferrable.

This is why dates come from metadata, grouping is automatic, and classification can happen later (by her or by an automated pass) rather than up front.

---

## 3. Core concepts / vocabulary

These names matter — earlier confusion came from conflating "where information comes from" with "when it happened." They are two separate axes.

**Channel** — the *source* of information. One master class. A channel has many sessions over time and can carry metadata (e.g. "taught by Professor —"). This is the structural axis.

**Session** — one *communication* from a channel: a single class delivered. A session belongs to exactly one channel. In practice a session is formed from **one upload batch** — the video plus the screenshots and notes captured alongside it — with the recording as its natural anchor. Two classes on the same day are two separate uploads, therefore two separate sessions. Date does **not** define a session.

**Media item** — a single video or image, belonging to a session. The row stores a *pointer* to the file (in object storage), never the file bytes.

**Note** — free text the user wrote, belonging to a session.

**Two dates, always.** Every item carries both:
- **event time** — when it happened / when the screenshot was taken (from file metadata)
- **ingestion time** — when it was added to the system (upload time)

These answer different questions and are never collapsed into one.

**Unsorted.** A session's channel may be *unknown* until the user (or a later automated pass) assigns it. The session still exists and is fully usable — it just isn't attached to a named channel yet. "Unsorted" = channel is null, not a special record.

---

## 4. Architecture at a glance

The defining move: **large files never touch the database.** Videos and images live in object storage; the database holds only metadata, pointers, and embeddings. This keeps the system sane at 100GB+.

The pipeline runs at **two speeds**:

- **Fast lane (user waits ~1s):** validate the file, run the similarity check, show the "add anyway?" dialog if needed, save the record, return control.
- **Slow lane (background):** transcribe video audio, analyze/OCR images, generate text embeddings. The item shows as "getting ready" until these finish, then becomes fully searchable in chat.

A background **job queue** drives the slow lane, with automatic retries (transcription and vision jobs fail and must retry cleanly).

---

## 5. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend / hosting | Vercel | Simple deploys, good iPad-web story |
| Database | Postgres (via Supabase) | One DB for metadata + vectors; RLS built in |
| Vector search | pgvector (in Postgres) | No separate vector DB needed at this scale |
| Text embeddings | Multilingual model (e.g. text-embedding-3, multilingual-e5) | Spanish + English content both searchable |
| Object storage | Cloudflare R2 | Zero egress fees — matters for streaming video back |
| Auth | Supabase Auth | Pairs with Postgres RLS for per-user isolation |
| Background jobs | Inngest or Trigger.dev | Managed queue + retries, minimal ops |
| Upload client | Uppy + AwsS3Multipart | Chunked, resumable, presigned uploads direct to R2 (S3-compatible) — no separate upload server |
| Transcription | Whisper API | ~$0.30–0.40 per 1hr class, zero ops |
| Image analysis | Vision model (OCR + description) | Cents per screenshot; feeds the chat |
| Similarity | SHA-256 + pHash + CLIP embeddings | Three-layer dedup cascade |

App is a **website (iPad-first, PWA-style)**. Native iOS is explicitly deferred (see §13).

---

## 6. Data model

Every table carries `user_id` (denormalized on purpose) so Postgres **row-level security** can enforce "she only ever sees her own rows" with one simple, fast policy per table — and so the chat's vector search filters by user *first*. This is the isolation guarantee, baked in rather than bolted on.

### `users`
Mirrors Supabase auth; app-level profile.
| Field | Type |
|---|---|
| id | uuid (PK) |
| email | string |
| created_at | timestamp |

### `channels` (the information source)
| Field | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| user_id | uuid (FK) | RLS |
| name | string | named by user |
| meta | jsonb | optional, e.g. instructor |
| created_at | timestamp | |

### `sessions` (one communication)
| Field | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| channel_id | uuid (FK) | **nullable** → "unsorted" |
| user_id | uuid (FK) | RLS |
| title | string | nullable, optional |
| session_date | date | nullable, event time of the class |
| created_at | timestamp | upload/ingest time |

### `media_items` (pointer + dedup toolkit)
| Field | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| session_id | uuid (FK) | |
| user_id | uuid (FK) | RLS |
| kind | string | `video` \| `image` |
| storage_key | string | R2 address (not the bytes) |
| mime_type | string | |
| original_filename | string | |
| size_bytes | bigint | |
| file_hash | string | SHA-256, exact-duplicate check (all kinds) |
| phash | string | perceptual hash — images only |
| clip_embedding | vector | image fingerprint — images only; visual similarity |
| keyframe_fingerprint | jsonb | video only, computed in background (library-time dedup) |
| captured_at | timestamp | event time, from metadata |
| status | string | `processing` \| `ready` \| `failed` |
| created_at | timestamp | ingestion time |

### `notes`
| Field | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| session_id | uuid (FK) | |
| user_id | uuid (FK) | RLS |
| body | text | |
| created_at | timestamp | |

### `text_chunks` (the RAG search layer)
Every searchable scrap of text becomes a chunk: notes split into chunks, transcripts split into chunks, screenshot OCR + vision descriptions split into chunks.
| Field | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| user_id | uuid (FK) | RLS + retrieval filter |
| session_id | uuid (FK) | for scoping/citation |
| source_type | string | `note` \| `transcript` \| `image_ocr` \| `image_vision` |
| source_id | uuid | points to the media_item or note |
| chunk_index | int | order within source |
| start_ms | int | transcript only — precise landing time in the video |
| end_ms | int | transcript only |
| char_start | int | note only — precise landing span in the note |
| char_end | int | note only |
| content | text | |
| embedding | vector | text embedding for search + chat |

**Two kinds of vectors, kept separate:** `clip_embedding` on `media_items` is an *image* fingerprint used only for dedup. `embedding` on `text_chunks` is a *text* fingerprint used only for chat. They never mix.

**Full transcript** — decided: yes, store it (see `transcripts` below) so she can read and **download** the whole class transcript (PDF or plain text), independent of the chunked copy used for search.

### `transcripts` (full, downloadable)
The complete transcript of a video — for reading and export. The chunked, timestamped copy in `text_chunks` is what search/chat use; this is the human-readable whole.
| Field | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| media_item_id | uuid (FK) | the video |
| user_id | uuid (FK) | RLS |
| full_text | text | whole transcript |
| language | string | detected by Whisper (e.g. `es`, `en`) |
| created_at | timestamp | |

### `duplicate_flags` (library-time "possible duplicate" badges)
Records a *suspected* duplicate found by a background job. Never triggers deletion — it drives a badge in the library that the user resolves (or ignores) whenever she likes.
| Field | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| user_id | uuid (FK) | RLS |
| item_id | uuid (FK) | the newer item |
| duplicate_of | uuid (FK) | the existing item it resembles |
| confidence | float | similarity score |
| status | string | `open` \| `dismissed` \| `resolved` |
| created_at | timestamp | |

---

## 7. Ingestion flow (iPad-first)

### The Photos picker
There is no special iOS API — a plain HTML file input triggers iPad Safari's native sheet (Photo Library / Take Photo or Video / Choose Files). Configuration:
- `accept="image/*,video/*"` filters to photos and videos.
- `multiple` lets her select a whole batch at once — this is what makes "one batch = one session" work.
- **Omit** the `capture` attribute — she's picking existing screenshots and recordings, not shooting fresh, so we want the full sheet with the library option.

Files come back as a standard `FileList` (name, mime type, size, last-modified), read with the browser File API. The same behavior applies whether she uses Safari or the site added to her Home Screen (PWA). There is no folder picking on iOS, and drag-from-Photos is unreliable — tap-to-open-sheet is the path.

### The upload path (fast lane)
1. **Pick files** — she multi-selects a batch (a recording + its screenshots).
2. **Request presign** — for each file, the iPad computes a **SHA-256 hash** and sends it (not the file) to our backend. The backend authenticates the user, runs the **exact-duplicate check**, and — if no exact match — creates the `media_items` row and returns presigned multipart URLs. Storage keys are namespaced per user: `users/{user_id}/{uuid}.{ext}`.
3. **Upload direct to R2** — the iPad uploads chunks **straight to R2** via Uppy AwsS3Multipart. Our backend is never in the data path. This is mandatory: Vercel functions cap request bodies at a few MB and time out in seconds, so a hundreds-of-MB recording *must* bypass them. Multipart = resumable, which is what saves an in-flight upload when iPadOS suspends the backgrounded tab.
4. **Finalize + image similarity** — the backend finalizes the multipart upload, then (images only) computes pHash + CLIP and checks for near/visual matches. If found, show the "add anyway?" dialog; on skip, delete the just-uploaded R2 object.
5. **Save + queue** — item saves with `status = processing` ("getting ready"); background jobs start (§9).
6. **Session forms from the batch** — the batch becomes a session, anchored on its recording; channel stays unsorted until assigned.

Batch uploads run in parallel with a concurrency cap (~3–4) so we don't saturate her wifi.

### Format handling (decided: hybrid, server-side)
iPad photos are HEIC, recordings are HEVC `.mov`. **Images:** upload as-is; convert to JPEG **server-side only if the file actually arrives as HEIC** (Safari often hands us JPEG already, especially from the Photo Library — but not from "Choose Files"). Cheap, since it usually isn't needed. **Video:** **never convert on the client** (far too heavy for a tablet). The transcription step extracts audio server-side. Whether we also transcode HEVC→H.264/MP4 for in-app playback depends on whether she rewatches recordings in the app — open thread (§14).

### Date handling — expect to ask, on iPad (important)
Our clean "pull `captured_at` from metadata" plan is **unreliable on iPad**: when iOS re-encodes HEIC→JPEG for the file input it frequently strips or rewrites EXIF (including capture time), `lastModified` often reflects export time rather than capture, and screenshots carry thin metadata to begin with. So the "ask her for the date" fallback is a **regular path here, not a rare edge case**. Two consequences:
- Make the prompt painless: a pre-filled date picker, one tap to accept, asked **once per batch** (not per file).
- Anchor the session date on the **video's container metadata**, which survives re-encoding better than a converted screenshot's EXIF — the recording is usually the more reliable date source for the whole session.

---

## 8. Deduplication — two tiers

Dedup is split into two jobs that happen at different moments. Cheap/fast checks catch it **at the door**; expensive checks (and all video visual-similarity) move to **background flagging** surfaced in the library. Neither ever auto-deletes — the user always decides.

### Tier 1 — upload-time gate (fast lane)
Catch it at the door with checks cheap enough to run while she waits:
1. **Exact duplicate** (all kinds) → SHA-256, checked **before upload** from the hash alone. On a match, the file never uploads; show the dialog immediately.
2. **Near-identical image** → pHash, after the (small) image lands.
3. **Visually similar image** → CLIP + cosine, above a tunable threshold. Images upload first and are **discarded on skip** — accepted trade-off, since images are small.

**Behavior: warn, never block.** Plain visual dialog — thumbnails of the existing items beside the new one, "You already have these — add it anyway?", two big buttons (Add anyway / Skip). No percentages, never the word "similarity."

### Tier 2 — library-time flagging (background)
Video visual-dedup is too expensive for the fast lane, so it runs as a **low-priority background job** after processing: sample keyframes, fingerprint them, compare against her other videos. A likely match writes a `duplicate_flags` row — it does **not** delete or interrupt. In the library, that item wears a quiet "possible duplicate of —" badge she can act on or ignore. This is also where any heavier image checks can live. "Flag it in the library" is deliberately simpler to build than "block it at upload," which is why video dedup can exist in MVP without being a blocker.

---

## 9. Background processing

Driven by the job queue, per item, with retries:

- **Video** → extract audio → transcribe (Whisper; **auto-detects language**, Spanish handled natively) → store the **full transcript** (`transcripts`, downloadable) → chunk *with timestamps* → embed into `text_chunks` (`transcript`).
- **Image** → OCR (slide text) + vision description (what the slide shows) → chunk → embed (`image_ocr`, `image_vision`).
- **Note** → chunk → embed (`note`).
- CLIP embedding for images is computed in the **fast** lane (needed for the dedup check); the deeper vision description is done here in the slow lane.
- **Video keyframe fingerprint** (for library-time dedup, §8 Tier 2) → low priority, writes `duplicate_flags` on a likely match.

When an item's jobs complete, its `status` flips to `ready` and it becomes searchable in chat. Friendly status copy throughout ("getting ready," not "transcription job queued").

---

## 10. Chat (RAG)

At query time: embed the question → retrieve the top-k most similar `text_chunks` **filtered to the requesting user** → an LLM answers, citing back to the source (the specific screenshot or moment in a video). User-scoping the retrieval is a hard correctness/security requirement, enforced via RLS and an explicit `user_id` filter — one person's chat can never reach another's data. Unsorted material is fully searchable; classification is organization, not a gate on search.

---

## 11. Search — precise landing

Search is a **separate surface from chat**, on the same retrieval layer: it returns the actual matching items, ranked, for her to browse — not a synthesized answer. One vector query over `text_chunks` returns **both** kinds of hit at once, because everything is embedded there: a screenshot (via its OCR/vision chunk) and a spoken passage (via its transcript chunk) come back together. Lighter than chat (no LLM call), and often what she wants ("find the slide about X").

**What we optimize: precise landing.** A result must point at *exactly* where the match is and render that spot:
- **Transcript hit** → the video, seeked to `start_ms`, matched passage highlighted ("plays from 12:43").
- **Screenshot hit** → the exact screenshot (`source_id` → `media_item`).
- **Note hit** → the note with the matched line highlighted (`char_start`/`char_end`).

**Baseline chunking (and why):** segment transcripts and notes at sentence level (each keeps its own tight locator), but embed a small rolling window of a few sentences for match quality. Embed coarse enough to match well, locate fine enough to land sharply — that decoupling is the baseline. Landing precision is a **known iteration area**, not something we perfect for MVP.

---

## 12. Language & Spanish content

Much of the material is in **Spanish** (English too), so multilingual is a baseline assumption, not a later add-on:
- **Transcription** — Whisper auto-detects language and transcribes in the source language; Spanish needs no special handling (don't force English). Detected `language` is stored on the transcript.
- **Embeddings** — use a **multilingual** embedding model so Spanish content is searchable and chattable.
- **OCR / vision** — the models read Spanish slide text fine.
- **Chat** — the LLM answers in the language she asks in.
- **Translation (EN→ES)** — explicitly **later**, not MVP.

---

## 13. MVP scope

**In scope**
- iPad-first web uploader (Photos picker, hybrid HEIC handling, resumable direct-to-R2 via AwsS3Multipart)
- Once-per-batch date prompt, anchored on the video's metadata
- Channels / sessions / media / notes data model with RLS
- Tier 1 upload-time dedup (exact hash + image pHash/CLIP) with the warn-and-confirm dialog
- Tier 2 library-time dedup: background video keyframe flagging + "possible duplicate" badges (`duplicate_flags`)
- Background transcription + image analysis + embedding
- Full transcript stored + **downloadable** (PDF / plain text)
- **Search** — precise landing to a transcript moment, screenshot, or note line
- User-scoped RAG chat with citations
- **Multilingual (Spanish + English)** end-to-end: transcription, embeddings, OCR, chat
- Auto-formed sessions (from upload batch); optional, deferrable naming and channel assignment
- "Unsorted" view + one-gesture assign-to-channel

**Out of scope (deferred, not forgotten)**
- Native iOS app (Share Sheet capture, true background uploads) — revisit only if batch upload proves to be real friction
- LLM-driven auto-grouping / re-organization of unsorted sessions into channels
- EN→ES (or any) translation of content — display/search in original language only for MVP
- Video visual-dedup at *upload* time (moved to Tier 2 background flagging)

---

## 14. Open threads to iterate before handoff

- **HEVC playback transcode:** does she rewatch recordings *in the app*? If yes, transcode HEVC→H.264/MP4 server-side (modest added cost) pulls into MVP; if she rewatches in Photos and only needs the transcript here, skip it.
- **Search landing precision:** chunk-window sizes and highlight behavior — iterate on the baseline in §11 with real content.
- **Embedding model choice:** confirm the specific multilingual model (quality vs. cost vs. dimensions).
- **Session naming UX:** auto-and-silent (rename later) vs. a one-line optional "name this class?" at end of upload. Leaning silent. Always the least input for her.
- **Dedup threshold:** tune the CLIP similarity cutoff to balance false positives vs. missed duplicates.
- **Hosting specifics:** confirm Supabase project setup, R2 bucket/region, queue provider choice (Inngest vs. Trigger.dev).

---

## 15. Post-MVP direction

Because every item hangs off a session by foreign key, and every session off a channel, **reorganizing is cheap** — it re-points links, it doesn't move data. The planned LLM auto-sort ("look at everything unsorted, propose a channel for each") is the same feature as the manual Unsorted bucket, approached from the other side. That's the natural first thing to build after MVP.
