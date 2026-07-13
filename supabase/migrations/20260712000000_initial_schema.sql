create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;
set search_path = public, extensions;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  channel_id uuid references public.channels(id) on delete set null,
  title text,
  session_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.media_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  kind text not null check (kind in ('video', 'image')),
  storage_key text not null,
  playback_key text,
  thumbnail_key text,
  mime_type text not null,
  original_filename text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  file_hash text not null,
  phash text,
  clip_embedding extensions.vector(512),
  keyframe_fingerprint jsonb,
  captured_at timestamptz,
  duration_ms bigint,
  width integer,
  height integer,
  status text not null default 'uploading' check (
    status in ('uploading', 'processing', 'dedup_review', 'ready', 'failed')
  ),
  processing_error_code text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  media_item_id uuid not null unique references public.media_items(id) on delete cascade,
  full_text text not null,
  language text,
  created_at timestamptz not null default now()
);

create table public.text_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  source_type text not null check (
    source_type in ('note', 'transcript', 'image_ocr', 'image_vision')
  ),
  source_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  start_ms bigint,
  end_ms bigint,
  char_start integer,
  char_end integer,
  content text not null,
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now()
);

create table public.duplicate_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  item_id uuid not null references public.media_items(id) on delete cascade,
  duplicate_of uuid not null references public.media_items(id) on delete cascade,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  status text not null default 'open' check (
    status in ('open', 'dismissed', 'resolved')
  ),
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.channels
  add constraint channels_id_user_id_key unique (id, user_id);

alter table public.sessions
  add constraint sessions_id_user_id_key unique (id, user_id);

alter table public.media_items
  add constraint media_items_id_user_id_key unique (id, user_id),
  add constraint media_items_user_session_fkey
    foreign key (user_id, session_id)
    references public.sessions(user_id, id)
    on delete cascade;

alter table public.notes
  add constraint notes_user_session_fkey
    foreign key (user_id, session_id)
    references public.sessions(user_id, id)
    on delete cascade;

alter table public.transcripts
  add constraint transcripts_user_media_fkey
    foreign key (user_id, media_item_id)
    references public.media_items(user_id, id)
    on delete cascade;

alter table public.text_chunks
  add constraint text_chunks_user_session_fkey
    foreign key (user_id, session_id)
    references public.sessions(user_id, id)
    on delete cascade;

alter table public.duplicate_flags
  add constraint duplicate_flags_item_user_fkey
    foreign key (user_id, item_id)
    references public.media_items(user_id, id)
    on delete cascade,
  add constraint duplicate_flags_duplicate_user_fkey
    foreign key (user_id, duplicate_of)
    references public.media_items(user_id, id)
    on delete cascade,
  add constraint duplicate_flags_distinct_items_check
    check (item_id <> duplicate_of);

create index channels_user_id_idx on public.channels(user_id);
create index sessions_user_created_idx on public.sessions(user_id, created_at desc)
  where deleted_at is null;
create index sessions_user_channel_idx on public.sessions(user_id, channel_id)
  where deleted_at is null;
create index media_items_user_hash_idx on public.media_items(user_id, file_hash)
  where deleted_at is null;
create index media_items_user_session_idx on public.media_items(user_id, session_id)
  where deleted_at is null;
create index media_items_user_status_idx on public.media_items(user_id, status)
  where deleted_at is null;
create index notes_user_session_idx on public.notes(user_id, session_id)
  where deleted_at is null;
create index text_chunks_user_session_idx on public.text_chunks(user_id, session_id);
create index duplicate_flags_user_status_idx on public.duplicate_flags(user_id, status);
create index chat_messages_user_created_idx on public.chat_messages(user_id, created_at);

create index text_chunks_embedding_idx on public.text_chunks
using hnsw (embedding vector_cosine_ops);

create index media_items_clip_embedding_idx on public.media_items
using hnsw (clip_embedding vector_cosine_ops);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sessions_set_updated_at
  before update on public.sessions
  for each row execute procedure public.set_updated_at();

create trigger notes_set_updated_at
  before update on public.notes
  for each row execute procedure public.set_updated_at();

alter table public.users enable row level security;
alter table public.channels enable row level security;
alter table public.sessions enable row level security;
alter table public.media_items enable row level security;
alter table public.notes enable row level security;
alter table public.transcripts enable row level security;
alter table public.text_chunks enable row level security;
alter table public.duplicate_flags enable row level security;
alter table public.chat_messages enable row level security;

create policy "users can read their profile"
  on public.users for select
  using (id = auth.uid());

create policy "users own channels"
  on public.channels for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users own sessions"
  on public.sessions for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users own media"
  on public.media_items for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users own notes"
  on public.notes for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users own transcripts"
  on public.transcripts for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users own text chunks"
  on public.text_chunks for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users own duplicate flags"
  on public.duplicate_flags for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users own chat messages"
  on public.chat_messages for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
