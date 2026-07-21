alter table public.media_items
  add column if not exists image_title_en text,
  add column if not exists image_title_es text;
