-- Re-enable video uploads for the transcription pipeline. Videos are transcribed
-- by the media worker (ffmpeg + OpenAI) into timestamped transcript chunks.
alter table public.media_items
  drop constraint if exists media_items_kind_check;

alter table public.media_items
  add constraint media_items_kind_check
  check (kind in ('image', 'document', 'video')) not valid;

alter table public.media_items
  drop constraint if exists media_items_mime_type_check;

alter table public.media_items
  add constraint media_items_mime_type_check
  check (
    mime_type in (
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/heic',
      'video/mp4',
      'video/quicktime'
    )
  ) not valid;

-- Whisper segment timestamps are kept alongside the transcript so chunking can
-- stay segment-aligned (start_ms/end_ms) whenever chunks are rebuilt.
alter table public.transcripts
  add column if not exists segments jsonb;

-- Videos are far larger than PDFs/images: raise the bucket cap to 2 GB and
-- allow video mime types. Uploads above ~6 MB should use the resumable
-- (TUS) protocol from the client.
update storage.buckets
set
  file_size_limit = 2147483648,
  allowed_mime_types = array[
    'image/jpeg',
    'image/png',
    'image/heic',
    'application/pdf',
    'video/mp4',
    'video/quicktime'
  ]::text[]
where id = 'media';
