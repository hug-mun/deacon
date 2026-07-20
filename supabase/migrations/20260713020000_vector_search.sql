alter table public.media_items
  drop constraint if exists media_items_processing_stage_check;

alter table public.media_items
  add constraint media_items_processing_stage_check
  check (processing_stage in ('queued', 'reading', 'saving', 'embedding', 'ready', 'failed'));

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
  join public.media_items as media
    on chunks.source_type = 'transcript'
    and chunks.source_id = media.id
  where chunks.user_id = match_user_id
    and media.user_id = match_user_id
    and media.deleted_at is null
    and media.status = 'ready'
  order by chunks.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 100);
$$;
