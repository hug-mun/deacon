# Deacon development log — July 16, 2026

## Completed in this development pass

- Started Docker Desktop and verified the Docker daemon is running.
- Started local Supabase and applied migration `20260716000000_lexical_retrieval_and_processing.sql`.
- Made `text_chunks.embedding` optional so text can be indexed before an embedding provider is configured.
- Added PostgreSQL full-text search with `search_text_chunks(...)`, live-source filtering, deleted-content filtering, and a GIN index.
- Updated vector retrieval to ignore chunks without vectors and to support live transcript/note/image-derived sources.
- Changed the PDF worker to always create durable transcript chunks.
- Backfilled chunks for all three existing PDFs: 54 + 42 + 20 = 116 chunks.
- Preserved optional `text-embedding-3-small` backfill when `OPENAI_API_KEY` is configured.
- Added processing attempt timestamps and a user-facing retry endpoint/button.
- Added transcript JSON/text download at `/api/media/:id/transcript`.
- Added notes CRUD endpoints. Notes are chunked immediately and are available to lexical search without embeddings.
- Added session listing support at `GET /api/sessions`.
- Added the local MCP Streamable HTTP endpoint at `/mcp` (with `/api/mcp` compatibility alias).
- Added MCP tools:
  - `search_knowledge`
  - `list_library`
  - `get_transcript`
- Added explicit user scoping for MCP queries and a local-only static-token mode for Inspector/smoke testing.
- Added `mcp-architecture.md` documenting the current boundary and the production prerequisites.
- Added `npm run test:mcp` for an end-to-end MCP JSON-RPC smoke test.
- Updated README and service status reporting to include the worker, lexical search, transcript download, retry, and MCP foundation.

## Verification completed

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `supabase db lint --local --level error --fail-on error` — passed with no schema errors.
- `supabase migration list --local` — all local migrations applied through `20260716000000`.
- Local lexical query for `mindfulness respiración` — returned matches from the long Rodrigo Restrepo PDF.
- Live MCP initialize, tool discovery, and `search_knowledge` calls — passed.
- The MCP smoke test returned 3 results, with the Rodrigo Restrepo PDF as the first source.

## Important current limitation

`OPENAI_API_KEY` is still not configured in the local environment. The system now works with PostgreSQL lexical retrieval, but actual embedding generation and hybrid ranking have not been exercised locally.

The MCP endpoint is a local development foundation. Before connecting it to ChatGPT, it still needs OAuth 2.1/protected-resource metadata, PKCE and scopes, HTTPS deployment, token audience/resource validation, rate limits, and Inspector coverage for authorization and isolation cases.

The documented media roadmap still has outstanding image OCR/vision/thumbnail processing, video/Whisper processing, batch/resumable R2 uploads, durable Inngest orchestration, chat/RAG streaming, channel management, soft-delete cascade/purge, and production observability.

## Follow-up: OpenAI embeddings and graceful failures

- Configured the supplied OpenAI key only in ignored `.env.local`; it is not part of the repository or browser bundle.
- Confirmed the embeddings endpoint accepts the key without printing the key or raw provider response.
- Ran the worker against the three existing PDFs; all 116 chunks now have `text-embedding-3-small` vectors.
- Confirmed vector retrieval returns the expected Rodrigo Restrepo PDF with a semantic similarity score.
- Added provider failure classification for exhausted quota/credits, rate limiting, invalid authentication, provider outages, invalid responses, and network errors.
- Search now falls back to PostgreSQL lexical results and returns a Spanish non-blocking notice when semantic search is unavailable.
- Embedding failures no longer make a successfully extracted transcript unusable; the worker keeps the media item ready and backs off repeated provider failures.
- Added route-level, global, not-found, and loading recovery screens with retry/library navigation instead of raw rendering failures.
- Verification after this follow-up: typecheck, lint, production build, MCP smoke test — all passed.

The quota distinction follows the official [OpenAI API error-code guidance](https://developers.openai.com/api/docs/guides/error-codes): exhausted quota is different from request-rate limiting and should be handled as a billing/availability condition rather than a generic server error.
