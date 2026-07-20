-- Retrieval must remain useful when an embedding provider is not configured.
-- Chunks are canonical text evidence; embeddings are an optional ranking layer.
alter table public.text_chunks
  alter column embedding drop not null;

alter table public.text_chunks
  add column if not exists search_vector tsvector
  generated always as (to_tsvector('simple'::regconfig, content)) stored;

create index if not exists text_chunks_search_vector_idx
  on public.text_chunks using gin (search_vector);

alter table public.media_items
  add column if not exists processing_attempts integer not null default 0,
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_completed_at timestamptz;

alter table public.media_items
  drop constraint if exists media_items_processing_attempts_check;

alter table public.media_items
  add constraint media_items_processing_attempts_check
  check (processing_attempts >= 0);

drop function if exists public.match_text_chunks(extensions.vector, uuid, integer);

create or replace function public.match_text_chunks(
  query_embedding extensions.vector(1536),
  match_user_id uuid,
  match_count integer default 20
)
returns table (
  id uuid,
  session_id uuid,
  source_type text,
  source_id uuid,
  content text,
  start_ms bigint,
  end_ms bigint,
  char_start integer,
  char_end integer,
  media_item_id uuid,
  original_filename text,
  similarity real
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    chunks.id,
    chunks.session_id,
    chunks.source_type,
    chunks.source_id,
    chunks.content,
    chunks.start_ms,
    chunks.end_ms,
    chunks.char_start,
    chunks.char_end,
    media.id as media_item_id,
    media.original_filename,
    (1 - (chunks.embedding <=> query_embedding))::real as similarity
  from public.text_chunks as chunks
  join public.sessions as sessions
    on sessions.id = chunks.session_id
    and sessions.user_id = match_user_id
    and sessions.deleted_at is null
  left join public.media_items as media
    on chunks.source_type in ('transcript', 'image_ocr', 'image_vision')
    and chunks.source_id = media.id
    and media.user_id = match_user_id
    and media.deleted_at is null
    and media.status = 'ready'
  left join public.notes as notes
    on chunks.source_type = 'note'
    and chunks.source_id = notes.id
    and notes.user_id = match_user_id
    and notes.deleted_at is null
  where chunks.user_id = match_user_id
    and chunks.embedding is not null
    and (
      (chunks.source_type = 'note' and notes.id is not null)
      or (chunks.source_type <> 'note' and media.id is not null)
    )
  order by chunks.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 100);
$$;

create or replace function public.search_text_chunks(
  query_text text,
  match_user_id uuid,
  match_count integer default 20
)
returns table (
  id uuid,
  session_id uuid,
  source_type text,
  source_id uuid,
  content text,
  start_ms bigint,
  end_ms bigint,
  char_start integer,
  char_end integer,
  media_item_id uuid,
  original_filename text,
  similarity real
)
language sql
stable
security invoker
set search_path = public
as $$
  with query as (
    select websearch_to_tsquery('simple'::regconfig, trim(query_text)) as ts_query
  )
  select
    chunks.id,
    chunks.session_id,
    chunks.source_type,
    chunks.source_id,
    chunks.content,
    chunks.start_ms,
    chunks.end_ms,
    chunks.char_start,
    chunks.char_end,
    media.id as media_item_id,
    coalesce(media.original_filename, 'Nota') as original_filename,
    ts_rank_cd(chunks.search_vector, query.ts_query)::real as similarity
  from public.text_chunks as chunks
  cross join query
  join public.sessions as sessions
    on sessions.id = chunks.session_id
    and sessions.user_id = match_user_id
    and sessions.deleted_at is null
  left join public.media_items as media
    on chunks.source_type in ('transcript', 'image_ocr', 'image_vision')
    and chunks.source_id = media.id
    and media.user_id = match_user_id
    and media.deleted_at is null
    and media.status = 'ready'
  left join public.notes as notes
    on chunks.source_type = 'note'
    and chunks.source_id = notes.id
    and notes.user_id = match_user_id
    and notes.deleted_at is null
  where chunks.user_id = match_user_id
    and chunks.search_vector @@ query.ts_query
    and (
      (chunks.source_type = 'note' and notes.id is not null)
      or (chunks.source_type <> 'note' and media.id is not null)
    )
  order by similarity desc, chunks.created_at desc
  limit least(greatest(match_count, 1), 100);
$$;
