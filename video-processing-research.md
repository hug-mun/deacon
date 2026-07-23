# Video Processing Research — Transcription, Chunking, and Timestamped Search

**Status:** Research complete, benchmarked on real footage
**Date:** July 22, 2026
**Test asset:** `Coding_Nick_Roberto_VoraaApp.mp4` (59.9 min, 835 MB, 1080p H.264, AAC stereo, embedded `mov_text` subtitle track) — unrelated to KB content; all tests ran isolated in a scratchpad, no database writes.
**Test machine:** Apple M3 Pro, 18 GB RAM.

## 1. Goal

Users upload master-class recordings (30–60 min). The system must extract the spoken knowledge, vectorize it into the existing knowledge base, and let search results deep-link to the exact moment in the video (or the matching transcript span). The existing schema already anticipates this: `text_chunks.start_ms/end_ms` flow through both search RPCs and the API today (always null), and `transcripts` is 1:1 with `media_items`.

## 2. Five processing methods benchmarked

All methods ran against the same 59.9-minute recording. "Agreement" is word-level agreement with the strongest transcript (whisper-1) as reference.

| # | Method | Wall time (60 min video) | Speed | Cost | Quality | Timestamps | Speakers |
|---|--------|--------------------------|-------|------|---------|------------|----------|
| 1 | **Embedded subtitle extraction** (ffmpeg `-map 0:s:0`) | < 1 s | ~instant | $0 | 73.9% agreement, ~12% of words dropped | fixed 4 s cues | ✅ (from meeting tool) |
| 2 | **OpenAI `whisper-1` API** (verbose_json, segment granularity) | 117 s | ~31× realtime | $0.36/hr ($0.006/min) | reference (best) | natural speech segments (566) | ❌ (use `gpt-4o-transcribe-diarize` variant) |
| 3 | **Apple SpeechAnalyzer** (`yap`, on-device, macOS 26) | 47 s | ~76× realtime | $0 | 88.7% | sentence cues (1,370), word-level available | ❌ |
| 4 | **whisper.cpp** (`base.en`, local CPU/Metal) | 66 s | ~54× realtime | $0 | 88.7% | natural segments (454) | ❌ (WhisperX/pyannote adds it) |
| 5 | **Scene keyframes + vision model** (ffmpeg scene>0.3 → `gpt-5.6-luna`) | 73 s extraction + ~6 s/frame | 62 frames from 60 min | ~$0.20/hr at `detail:low` | captures on-screen content speech never mentions (IDE, file names, slides) | per-frame `pts_time` | n/a |

Not run due to network constraints (models wouldn't download), included from published benchmarks:

- **mlx-whisper** (Apple-GPU, `large-v3-turbo`): ~8–15× realtime on M-series, best local quality tier. Only relevant if processing happens on a Mac.
- **faster-whisper / WhisperX** (CTranslate2): the standard server-side self-host stack; WhisperX adds word-level alignment + speaker diarization on top. What we'd containerize if we self-host.
- **Hosted STT APIs** (Deepgram Nova, AssemblyAI): 2026 comparisons put AssemblyAI ahead on noisy-audio accuracy and Deepgram on latency/price at scale; both include diarization. A second vendor dependency — only worth it if Whisper accuracy proves insufficient on real class audio.

### Key observations

- **The embedded subtitle track is real and free but lossy.** The meeting recorder's live captions dropped ~12% of words and garbled technical phrases. Good enough as an *instant provisional* transcript (it also carries speaker names, which Whisper does not), not good enough as the final index.
- **whisper-1's segments are the best chunking substrate** — natural speech units instead of fixed 4-second cues.
- **Vision on keyframes is a real enrichment for screen recordings**: the sample frame captured the IDE, simulator, and project tree — none of it spoken aloud. At `detail:low` it misread fine text (called Cursor "Xcode"); reading code/filenames reliably needs `detail:high` (~4× cost). Phase-2 material.
- **Audio prep matters for the API path**: 60 min re-encoded to 32 kbps mono MP3 is 14 MB — under whisper-1's 25 MB cap. A 30-min class is ~7 MB. `ffmpeg -vn -ac 1 -ar 16000 -b:a 32k` runs in seconds.

## 3. Chunking and retrieval findings

Mirrored the production chunker (1800 chars ≈ 160 s of speech) and compared against segment-aligned ~600-char chunks (≈ 58 s of speech), embedded with `text-embedding-3-small` (1536-d, same as production), and queried with five test questions.

- **All transcript pipelines retrieve the same correct region** for topical queries (e.g. "home screen feature not shown in store release" → ~30–33 min in every pipeline). Retrieval robustness comes mostly from chunking, not engine choice — but whisper-quality text consistently scores higher similarity than the lossy captions.
- **Smaller chunks win for video.** ~600-char segment-aligned chunks produced *higher* top-1 similarity (0.578 vs 0.529 on the best query) and a jump target of ~60 s instead of ~160 s. Recommendation: chunk video transcripts at **600–900 chars aligned to segment boundaries, one-segment overlap**, carrying `start_ms/end_ms` per chunk.
- **Cross-lingual retrieval works but is weak** (Spanish query over English transcript scored ~0.21 vs ~0.5 same-language). `text-embedding-3-small` is multilingual, so Spanish classes are searchable in Spanish without translation. For cross-language queries, consider embedding a translated copy later — not MVP.
- **Storage is negligible**: full transcript + ~90 chunks + 1536-d embeddings ≈ 0.5 MB per hour of video, vs 835 MB for the video itself.

## 4. "Transcript-only" option

If storage cost ever matters, the knowledge value is almost entirely in the transcript (~40 KB/hr) + audio (14 MB/hr as MP3). Options, cheapest first:

1. Transcript only — search works, no moment playback.
2. Transcript + compressed audio — "listen from 31:02" without video storage.
3. Transcript + 720p transcode (~350 MB/hr) — full experience, ~60% smaller.
4. Transcript + original video — current-quality experience, max storage.

Since deep-linking to the moment is an explicit product goal, option 3 or 4 is the target; 30-min classes at 720p ≈ 175 MB each.

## 5. Recommended production pipeline (30-min videos)

> **Status update (July 23, 2026): implemented.** Migration `20260723000000_video_uploads.sql`, `processVideo()` in `scripts/process-media.mjs` (behind the single `transcribeAudio()` boundary for the future Mac mini lane), video mimes in `uploads/prepare` and the upload panel, resumable TUS uploads for large files (`src/lib/upload/resumable.ts`), `VideoPlayer` component with seek-to-moment from search results, and ffmpeg in `Dockerfile.worker`. Instances without ffmpeg (the Vercel lane) skip video items so the Docker worker picks them up.

**Primary lane (matches existing worker architecture, no new infra):**

1. Re-allow `video/mp4` (+ `video/quicktime`) in `uploads/prepare` and the `media_items.kind` check (dropped in `20260722010000_pdf_image_uploads_only.sql`).
2. Worker `processVideo()` branch in `scripts/process-media.mjs`:
   - ffmpeg: extract 32 kbps mono MP3 (seconds of work; ffmpeg must be in the worker image — it is a Docker worker, so add the package).
   - If an embedded subtitle track exists, extract it and store immediately as a provisional transcript (instant availability + speaker names).
   - Send audio to **`whisper-1` with `verbose_json` + segment timestamps** (≈ 60 s and $0.18 per 30-min class). Store `full_text` + language in `transcripts`, replacing the provisional one.
   - Chunk segments at 600–900 chars, segment-aligned, writing `start_ms/end_ms` on every `text_chunks` row (`source_type='transcript'`).
   - Embed via the existing `pollPendingEmbeddings()` lane — no changes needed.
   - Reuse the existing rollback (`rollbackMediaIndex`) and failure-alert paths; add error codes for `transcription_*` mirroring the vision/embedding ones.
3. Frontend: search results already receive `start_ms` — add `videoRef.currentTime = start_ms/1000` on match click, and highlight the transcript span.

**Why whisper-1 over the local engines for production:** the worker runs in a CPU container (no Apple GPU); local whisper.cpp would be minutes-per-video on server CPUs vs ~1 min via API, and the project already depends on OpenAI for vision + embeddings, with the same failure/quota handling. At $0.18 per 30-min class, cost is immaterial next to storage.

**Fallback/offline lane (optional later):** whisper.cpp or faster-whisper `small` (multilingual) in the Docker worker for zero marginal cost or provider-outage resilience. `base.en` is English-only — Spanish classes need `small`+ or the API.

**Machine-capacity constraints (this Mac: M3 Pro, 18 GB RAM):** everything recommended here runs comfortably or not-at-all locally by design. Whisper model RAM footprints: `base` ≈ 0.3 GB, `small` ≈ 0.9 GB, `medium` ≈ 2.6 GB, `large-v3-turbo` ≈ 3.5 GB peak — all fit on this machine, but only `base`/`small` are worth running routinely while doing other work. No GPU training, no PyTorch stack, no local vector index: embeddings and vision stay on the OpenAI API, and pgvector lives in Supabase. Nothing in this plan requires local deep-learning capacity beyond an optional quantized Whisper model.

**Phase 2 enrichments:**
- Scene keyframes (ffmpeg `select='gt(scene,0.3)'`) → vision analysis → `image_vision`-style chunks tagged with the frame's `start_ms`; lets search hit content that is only on screen. The unused `clip_embedding vector(512)` column was designed for exactly this family of features.
- Speaker labels: keep them when the embedded track has them; otherwise `gpt-4o-transcribe-diarize` or WhisperX if "who said it" becomes a search need.

## 6. Willow Voice / dictation-app note

Willow Voice (installed on this Mac) is a live cloud dictation tool for typing — the wrong shape for batch server-side video processing. Its open-source analogues (VoiceInk, OpenWhispr, whisper.cpp-based apps) all converge on the same engine family recommended above: Whisper. For translation, Whisper natively translates any language → English (`task=translate`); open-source multi-directional translation would be Meta NLLB — but since the embedding model is multilingual, translation is not required for search to work in the MVP.

## 7. Cost summary and budget per class

**Decision (July 23, 2026):** processing cost is budgeted at **≤ $1.00 (USD) per video class** — a hard ceiling with wide margin over the measured actuals below. Launch lane is the whisper-1 API.

| Item | Cost (30 min) | Cost (60 min) |
|---|---|---|
| whisper-1 transcription | ~$0.18 | ~$0.36 |
| Embeddings (~45–90 chunks) | < $0.01 | < $0.01 |
| Keyframe vision (phase 2, low detail) | ~$0.10 | ~$0.20 |
| **Total processing** | **~$0.20–0.30** | **~$0.40–0.60** |
| Storage (720p transcode + transcript) | ~175 MB | ~350 MB |

## 8. Deferred: local Mac mini transcription lane

**Decision (July 23, 2026):** a Mac mini (Apple Silicon, M4-class) will be purchased later and added as a **local transcription worker** to replace the per-class API cost with a $0 marginal-cost lane. Until then, the API lane above is the only transcription path — the code should keep the transcription step behind a single boundary (one `transcribeAudio()` call in the worker) so the Mac mini lane can be swapped in without touching chunking, embedding, or search.

Planned shape when the hardware arrives:

- The mini runs a small poller (same pattern as `scripts/process-media.mjs`) against the existing queue: claim `media_items` with `status='processing'` and `kind='video'`, pull audio from Storage, transcribe locally with **mlx-whisper `large-v3-turbo`** (Apple GPU, ~10–15× realtime) or whisper.cpp `small` (multilingual), write `transcripts` + timestamped `text_chunks` back.
- Cloud API lane stays as automatic fallback when the mini is offline (power, macOS updates, home ISP) — availability is the main risk of a home worker, not capability.
- Hardware note: the base Mac mini M4 16 GB is sufficient (whisper `large-v3-turbo` peaks ~3.5 GB RAM); higher tiers add nothing to this workload.

Sources: [OpenAI transcription pricing](https://costgoat.com/pricing/openai-transcription) · [Whisper vs Deepgram vs AssemblyAI 2026](https://deepgram.com/learn/deepgram-vs-assemblyai-vs-whisper) · [RAG for video transcripts](https://vidnavigator.com/en/blog/rag-for-video-transcripts) · [Willow open-source alternatives](https://openalternative.co/alternatives/willow)
