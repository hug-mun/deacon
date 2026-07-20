alter table public.media_items
  add column if not exists image_description text,
  add column if not exists image_ocr_text text,
  add column if not exists image_keywords text[] not null default '{}';
