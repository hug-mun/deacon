-- The current product only accepts PDFs and images. Keep the constraint NOT VALID
-- so any legacy video rows remain readable while new writes are restricted.
alter table public.media_items
  drop constraint if exists media_items_kind_check;

alter table public.media_items
  add constraint media_items_kind_check
  check (kind in ('image', 'document')) not valid;

alter table public.media_items
  add constraint media_items_mime_type_check
  check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')) not valid;
