alter table public.media_items
  drop constraint if exists media_items_kind_check;

alter table public.media_items
  add constraint media_items_kind_check
  check (kind in ('video', 'image', 'document'));

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/pdf'
]::text[]
where id = 'media';
