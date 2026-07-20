alter table public.media_items
  add column if not exists processing_stage text not null default 'queued',
  add column if not exists processing_progress smallint not null default 0;

alter table public.media_items
  drop constraint if exists media_items_processing_stage_check;

alter table public.media_items
  add constraint media_items_processing_stage_check
  check (processing_stage in ('queued', 'reading', 'saving', 'ready', 'failed'));

alter table public.media_items
  drop constraint if exists media_items_processing_progress_check;

alter table public.media_items
  add constraint media_items_processing_progress_check
  check (processing_progress between 0 and 100);

update public.media_items
set processing_stage = case
      when status = 'ready' then 'ready'
      when status = 'failed' then 'failed'
      else 'queued'
    end,
    processing_progress = case
      when status = 'ready' then 100
      else 0
    end
where processing_stage = 'queued'
  and processing_progress = 0;
