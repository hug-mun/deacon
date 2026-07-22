-- Soft-deleted media remains recoverable for 30 days. The worker removes
-- expired rows and their storage objects after that window.
create index if not exists media_items_user_hash_deleted_idx
  on public.media_items (user_id, file_hash, deleted_at);

create unique index if not exists media_items_user_active_hash_key
  on public.media_items (user_id, file_hash)
  where deleted_at is null;
