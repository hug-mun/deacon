alter table public.media_items
  add column if not exists processing_error_service text,
  add column if not exists processing_error_message text,
  add column if not exists processing_error_request_id text;
